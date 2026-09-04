import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow, session } from 'electron'
import {
  allowMediaRoot,
  defaultMediaRoots,
  handleMediaProtocol,
  registerMediaScheme,
} from './media/protocol'
import { registerExportService, setPendingExport, whenExportFinished } from './media/export-service'
import { startControlServer } from './control/server'
import { createWindowManager, type WindowManager } from './windows/manager'

// app.whenReady() より前に呼ぶ必要がある
registerMediaScheme()

/**
 * Web MIDI は既定で拒否されるため明示的に許可する (設計書 §2.2.14)。
 * P0-22 で許可対象を精査し、恒久テストを追加する。
 */
const configurePermissions = (): void => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'midi' || permission === 'midiSysex' || permission === 'media')
  })
}

/**
 * VJDJ_SELFTEST=1 のとき、RealtimeChannel の疎通を検証して終了する。
 *
 * 「ポートが配られた」だけでは不十分で、実際に往復したことまで確認する。
 * S001-R (100 回連続起動して 100 回成立する) の自動化に使う。
 */
const runSelfTest = async (windows: WindowManager): Promise<number> => {
  try {
    await windows.whenChannelEstablished(15_000)
  } catch (error) {
    console.error(`SELFTEST FAIL establish: ${error instanceof Error ? error.message : ''}`)
    return 1
  }

  const deadline = Date.now() + 15_000
  for (;;) {
    const state = (await windows.control.webContents.executeJavaScript(
      'String(window.__vjdjHandshake?.state ?? "pending")',
    )) as string

    if (state === 'ok') {
      const rtt = (await windows.control.webContents.executeJavaScript(
        'Number(window.__vjdjHandshake?.rttMs ?? -1)',
      )) as number
      console.log(`SELFTEST PASS rtt=${rtt.toFixed(2)}ms displays=${windows.listDisplays().length}`)
      return 0
    }
    if (state === 'failed') {
      const detail = (await windows.control.webContents.executeJavaScript(
        'String(window.__vjdjHandshake?.error ?? "")',
      )) as string
      console.error(`SELFTEST FAIL handshake: ${detail}`)
      return 1
    }
    if (Date.now() > deadline) {
      console.error('SELFTEST FAIL timeout: handshake stayed pending')
      return 1
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * VJDJ_CAPTURE=<出力パス> のとき、Engine Host の画をファイルに書き出して終了する。
 *
 * 画作りは数値では判断できない。実際の画を見ずにパラメータを調整するのは
 * 目をつぶって色を選ぶようなもので、クロマキーの閾値や構図の追い込みには
 * 画を確認する手段が必須になる。
 */
const runCapture = async (windows: WindowManager, outputPath: string): Promise<number> => {
  const waitMs = Number(process.env['VJDJ_CAPTURE_DELAY_MS'] ?? '6000')
  await new Promise((resolve) => setTimeout(resolve, waitMs))

  try {
    const image = await windows.engine.webContents.capturePage()
    const png = image.toPNG()
    await writeFile(outputPath, png)
    const size = image.getSize()
    console.log(`CAPTURE OK ${outputPath} ${size.width}x${size.height} ${png.length} bytes`)
    return 0
  } catch (error) {
    console.error(`CAPTURE FAIL ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

void app.whenReady().then(async () => {
  configurePermissions()

  handleMediaProtocol()
  for (const root of defaultMediaRoots()) allowMediaRoot(root)
  registerExportService()

  // VJDJ_EXPORT=<出力パス> で書き出しモードに入る
  const exportPath = process.env['VJDJ_EXPORT']
  if (exportPath !== undefined && exportPath !== '') {
    setPendingExport({
      outputPath: exportPath,
      width: Number(process.env['VJDJ_EXPORT_WIDTH'] ?? '1920'),
      height: Number(process.env['VJDJ_EXPORT_HEIGHT'] ?? '1080'),
      fps: Number(process.env['VJDJ_EXPORT_FPS'] ?? '30'),
      durationSeconds: Number(process.env['VJDJ_EXPORT_DURATION'] ?? '90.47'),
      startSeconds: Number(process.env['VJDJ_EXPORT_START'] ?? '0'),
      audioPath: process.env['VJDJ_EXPORT_AUDIO'] ?? null,
      crf: Number(process.env['VJDJ_EXPORT_CRF'] ?? '18'),
    })
  }

  const windows = createWindowManager()

  for (const display of windows.listDisplays()) {
    console.log(
      `[main] display ${String(display.id)} ${String(display.bounds.width)}x${String(display.bounds.height)} ` +
        `scale=${String(display.scaleFactor)}${display.isPrimary ? ' (primary)' : ''}`,
    )
  }

  if (process.env['VJDJ_EXPORT'] !== undefined && process.env['VJDJ_EXPORT'] !== '') {
    const result = await whenExportFinished()
    windows.dispose()
    app.exit(result.ok ? 0 : 1)
    return
  }

  const capturePath = process.env['VJDJ_CAPTURE']
  if (capturePath !== undefined && capturePath !== '') {
    const code = await runCapture(windows, capturePath)
    windows.dispose()
    app.exit(code)
    return
  }

  if (process.env['VJDJ_SELFTEST'] === '1') {
    const code = await runSelfTest(windows)
    windows.dispose()
    app.exit(code)
    return
  }

  // MCP / 外部からの操作を受け付ける (127.0.0.1 限定)。
  // VJDJ_CONTROL_PORT=0 で自動割り当て、未指定なら 7321。
  const controlPort = Number(process.env['VJDJ_CONTROL_PORT'] ?? '7321')
  if (controlPort >= 0) {
    try {
      const control = await startControlServer(windows.engine, controlPort)
      app.on('before-quit', () => {
        void control.close()
      })
    } catch (error) {
      console.error(
        `[control] failed to start: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindowManager()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
