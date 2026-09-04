import { join } from 'node:path'
import { BrowserWindow, MessageChannelMain, ipcMain, screen, shell } from 'electron'
import type { RawValue } from '@shared/protocol/raw'
import { isWindowRole, type DisplayInfo, type WindowRole } from '@shared/protocol/window'

/**
 * 両ウィンドウの生成と、RealtimeChannel のポート配布を担う。
 *
 * ポート配布は Electron でレースが起きやすい箇所として知られている。
 * `ready-to-show` などのウィンドウ側イベントを合図にすると、
 * 受信側のリスナ登録前にポートが届いて取りこぼす。
 * そのため **レンダラ主導のハンドシェイク** を採る:
 *   レンダラが主ワールドのリスナ登録を終える
 *     → preload が `window:ready` を送る
 *       → main は両方揃ってから初めてポートを配る
 */

export type WindowManager = {
  readonly control: BrowserWindow
  readonly engine: BrowserWindow
  /** 両レンダラへポートを配り終えたら解決する */
  whenChannelEstablished(timeoutMs?: number): Promise<void>
  listDisplays(): readonly DisplayInfo[]
  dispose(): void
}

const ROLES: readonly WindowRole[] = ['control', 'engine']

const PRELOAD = join(import.meta.dirname, '../preload/index.cjs')

const rendererEntry = (
  role: WindowRole,
): { url: string } | { file: string; query: Record<string, string> } => {
  const dir = role === 'control' ? 'ui' : 'engine'
  // 検証用のパラメータをレンダラへ渡す
  const query: Record<string, string> = {}
  const audioTest = process.env['VJDJ_AUDIO_TEST']
  if (role === 'engine' && audioTest !== undefined && audioTest !== '')
    query['audioTest'] = audioTest
  if (role === 'engine' && process.env['VJDJ_SEQ_TEST'] === '1') query['seqTest'] = '1'

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl !== undefined) {
    const search = new URLSearchParams(query).toString()
    return { url: `${devServerUrl}/${dir}/index.html${search === '' ? '' : `?${search}`}` }
  }
  return { file: join(import.meta.dirname, `../renderer/${dir}/index.html`), query }
}

const createWindow = (
  role: WindowRole,
  options: Electron.BrowserWindowConstructorOptions,
): BrowserWindow => {
  const window = new BrowserWindow({
    ...options,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      // 役割を preload へ渡す。preload は sandbox 内でも process.argv を読める。
      additionalArguments: [`--vjdj-role=${role}`],
      // 設計書 §6.1 の堅牢化設定。P0-22 でこの値そのものを assert する恒久テストを追加する。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Engine Host は非フォーカス・最小化でも 60fps を維持する必要がある。
      // PoC (PC008) でこの設定により維持されることを実測済み。
      backgroundThrottling: false,
    },
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('console-message', (event) => {
    const line = `[${role}] ${event.level}: ${event.message}`
    if (event.level === 'error') console.error(line)
    else console.log(line)
  })
  window.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error(`[${role}] load failed ${String(code)} ${description} ${url}`)
  })
  window.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[${role}] renderer gone: ${details.reason}`)
  })

  const entry = rendererEntry(role)
  void ('url' in entry
    ? window.loadURL(entry.url)
    : window.loadFile(entry.file, { query: entry.query }))

  return window
}

const toDisplayInfo = (display: Electron.Display, primaryId: number): DisplayInfo => ({
  id: display.id,
  label: display.label,
  bounds: display.bounds,
  scaleFactor: display.scaleFactor,
  isPrimary: display.id === primaryId,
})

export const createWindowManager = (): WindowManager => {
  const primary = screen.getPrimaryDisplay()

  const control = createWindow('control', {
    width: 1440,
    height: 900,
    title: 'VJDJ — Control',
    backgroundColor: '#101014',
  })

  const engine = createWindow('engine', {
    width: 960,
    height: 540,
    x: primary.workArea.x + 80,
    y: primary.workArea.y + 80,
    title: 'VJDJ — Output',
    backgroundColor: '#000000',
  })

  const byRole: Record<WindowRole, BrowserWindow> = { control, engine }
  const ready = new Set<WindowRole>()
  const establishedListeners = new Set<() => void>()
  let established = false

  const distributePorts = (): void => {
    const channel = new MessageChannelMain()
    // main はポートを渡すだけで、以降のメッセージには一切関与しない。
    // ImageBitmap のような DOM オブジェクトは main では復元できないため、
    // この方式でなければゼロコピー転送 (設計書 §2.2.10) が成立しない。
    control.webContents.postMessage('realtime:port', null, [channel.port1])
    engine.webContents.postMessage('realtime:port', null, [channel.port2])
    established = true
    for (const listener of establishedListeners) listener()
    establishedListeners.clear()
  }

  const roleOfSender = (senderId: number): WindowRole | undefined =>
    ROLES.find((role) => {
      const window = byRole[role]
      return !window.isDestroyed() && window.webContents.id === senderId
    })

  const onWindowReady = (event: Electron.IpcMainEvent, claimedRole: RawValue): void => {
    // 送信元は webContents の id で特定する。ペイロードの role は照合にのみ使う
    // (レンダラ由来の値を信頼して分岐しない)。
    const role = roleOfSender(event.sender.id)
    if (role === undefined) return

    if (typeof claimedRole !== 'string' || !isWindowRole(claimedRole) || claimedRole !== role) {
      // RawValue はオブジェクトでもありうるので String() は使わない
      const claimed = JSON.stringify(claimedRole) ?? 'undefined'
      console.error(`[main] window:ready role mismatch: claimed=${claimed} actual=${role}`)
      return
    }

    ready.add(role)
    if (ready.size === ROLES.length) distributePorts()
  }

  ipcMain.on('window:ready', onWindowReady)

  // リロードすると主ワールドのリスナは消えるので、再度 ready を待つ。
  for (const role of ROLES) {
    byRole[role].webContents.on('did-start-loading', () => {
      ready.delete(role)
      established = false
    })
  }

  return {
    control,
    engine,

    whenChannelEstablished: (timeoutMs = 15_000) =>
      new Promise<void>((resolve, reject) => {
        if (established) {
          resolve()
          return
        }
        const onEstablished = (): void => {
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          establishedListeners.delete(onEstablished)
          reject(
            new Error(
              `realtime channel not established within ${String(timeoutMs)}ms ` +
                `(ready: ${[...ready].join(',') || 'none'})`,
            ),
          )
        }, timeoutMs)
        establishedListeners.add(onEstablished)
      }),

    listDisplays: () => {
      const primaryId = screen.getPrimaryDisplay().id
      return screen.getAllDisplays().map((d) => toDisplayInfo(d, primaryId))
    },

    dispose: () => {
      ipcMain.removeListener('window:ready', onWindowReady)
      establishedListeners.clear()
      for (const role of ROLES) {
        const window = byRole[role]
        if (!window.isDestroyed()) window.destroy()
      }
    },
  }
}
