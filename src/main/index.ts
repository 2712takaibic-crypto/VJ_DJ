import { app, BrowserWindow, session } from 'electron'
import { createWindowManager, type WindowManager } from './windows/manager'

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

void app.whenReady().then(async () => {
  configurePermissions()

  const windows = createWindowManager()

  for (const display of windows.listDisplays()) {
    console.log(
      `[main] display ${String(display.id)} ${String(display.bounds.width)}x${String(display.bounds.height)} ` +
        `scale=${String(display.scaleFactor)}${display.isPrimary ? ' (primary)' : ''}`,
    )
  }

  if (process.env['VJDJ_SELFTEST'] === '1') {
    const code = await runSelfTest(windows)
    windows.dispose()
    app.exit(code)
    return
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
