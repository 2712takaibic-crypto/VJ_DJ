/**
 * P0-2: プラットフォーム能力 PoC (PC001 / PC008)
 *
 * 本番と同じレンダラ設定 (sandbox / contextIsolation / backgroundThrottling) で
 * 計測することが必須。設定を緩めて測ると数値が転用できない。
 *
 * 実行:
 *   npm run poc:platform              (各フェーズ 60 秒)
 *   POC_SECONDS=300 npm run poc:platform   (テスト設計 §4.3 の正式条件)
 */
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const SECONDS = Number(process.env['POC_SECONDS'] ?? '60')

/** `--enable-unsafe-webgpu` が必要かどうかも判定材料になるため、既定では付けない */
const forceUnsafeWebgpu = process.env['POC_UNSAFE_WEBGPU'] === '1'
if (forceUnsafeWebgpu) {
  app.commandLine.appendSwitch('enable-unsafe-webgpu')
}

const logLines = []
const say = (m) => {
  logLines.push(m)
  console.log(m)
}

let engineWindow = null
let focusWindow = null

const finish = (payload) => {
  const gpuFeatureStatus = app.getGPUFeatureStatus()

  const verdict = {
    // PC001: アダプタ 10/10 取得でき、デバイス生成と実描画まで通ること
    PC001:
      payload.webgpu?.adapterSuccesses === 10 &&
      payload.webgpu?.deviceCreated === true &&
      payload.webgpu?.renderSucceeded === true
        ? 'PASS'
        : 'FAIL',
    // PC008: 非フォーカス時も 60fps を維持 (58fps 以上、かつ p99 が 20ms 未満)
    PC008:
      payload.raf?.unfocused?.fps >= 58 && payload.raf?.unfocused?.intervalMs?.p99 < 20
        ? 'PASS'
        : 'FAIL',
  }

  const result = {
    ranAt: new Date().toISOString(),
    secondsPerPhase: SECONDS,
    forceUnsafeWebgpu,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    displays: screen.getAllDisplays().map((d) => ({
      id: d.id,
      size: d.size,
      scaleFactor: d.scaleFactor,
      internal: d.internal,
    })),
    gpuFeatureStatus,
    ...payload,
    verdict,
  }

  const outDir = join(repoRoot, '.tmp')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, 'poc-platform.json')
  writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8')

  say('')
  say('================ RESULT ================')
  say(`PC001 (WebGPU)              : ${verdict.PC001}`)
  say(`PC008 (background throttle) : ${verdict.PC008}`)
  say(`gpu_compositing             : ${gpuFeatureStatus.gpu_compositing}`)
  say(`webgpu                      : ${gpuFeatureStatus.webgpu ?? '(not reported)'}`)
  say(`vulkan                      : ${gpuFeatureStatus.vulkan ?? '(not reported)'}`)
  if (payload.raf) {
    for (const p of [payload.raf.focused, payload.raf.unfocused, payload.raf.minimized]) {
      if (!p) continue
      say(
        `raf ${p.label.padEnd(9)}: ${p.fps.toFixed(2)}fps  ` +
          `p50=${p.intervalMs.p50?.toFixed(2)}  p95=${p.intervalMs.p95?.toFixed(2)}  ` +
          `p99=${p.intervalMs.p99?.toFixed(2)}  max=${p.intervalMs.max?.toFixed(2)}  ` +
          `dropped>20ms=${p.droppedOver20ms}  hiddenFrames=${p.hiddenFrames}`,
      )
    }
  }
  say(`written: ${outPath}`)
  say('========================================')

  app.exit(verdict.PC001 === 'PASS' && verdict.PC008 === 'PASS' ? 0 : 1)
}

ipcMain.on('poc:log', (_e, m) => say(`  [engine] ${m}`))
ipcMain.handle('poc:config', () => ({ seconds: SECONDS }))

ipcMain.on('poc:report', (_e, payload) => {
  if (payload.phase === 'defocus') {
    // Engine Host を非フォーカスかつ遮蔽状態にする。
    // backgroundThrottling: false が本当に効いているかはこの状態でしか分からない。
    focusWindow?.show()
    focusWindow?.focus()
    focusWindow?.moveTop()
    say('  [main] focus stealer raised — engine window is now unfocused and occluded')
    return
  }
  if (payload.phase === 'minimize') {
    engineWindow?.minimize()
    say('  [main] engine window minimized')
    return
  }
  if (payload.phase === 'done') {
    finish(payload)
  }
})

app.whenReady().then(async () => {
  const primary = screen.getPrimaryDisplay()
  const { x, y, width, height } = primary.workArea

  engineWindow = new BrowserWindow({
    x: x + 40,
    y: y + 40,
    width: 640,
    height: 420,
    title: 'PoC — Engine Host',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      // ★ 本番と同一の設定で測る
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })

  focusWindow = new BrowserWindow({
    x: x + Math.floor(width * 0.15),
    y: y + Math.floor(height * 0.1),
    width: Math.floor(width * 0.7),
    height: Math.floor(height * 0.7),
    show: false,
    title: 'PoC — Focus Stealer',
  })
  await focusWindow.loadFile(join(here, 'focus.html'))

  say(`electron=${process.versions.electron} chromium=${process.versions.chrome}`)
  say(`seconds per phase = ${SECONDS} (POC_SECONDS で変更可)`)
  say(`enable-unsafe-webgpu = ${forceUnsafeWebgpu}`)
  say('')

  engineWindow.webContents.on('console-message', (event) => {
    if (event.level === 'error') say(`  [engine:error] ${event.message}`)
  })

  await engineWindow.loadFile(join(here, 'engine.html'))
})

app.on('window-all-closed', () => app.exit(1))
