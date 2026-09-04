/**
 * 層 2 (GPU) / 層 3 (音声) のテストランナー。
 *
 * これらのテストは Electron のレンダラ内でしか動かせない
 * (WebGPU / AudioWorklet が必要)。
 *
 * 仕組み: Vite の開発サーバーを起動し、Electron のウィンドウで
 * runner.html を開く。Vite が TypeScript とエイリアスを解決するので、
 * テストは製品コードをそのまま import できる。
 *
 * 実行:
 *   npm run test:gpu
 *   npm run test:audio
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

// 環境変数ではなく引数で受ける。
// Windows の cmd.exe では `VAR=x command` 形式が使えず、
// npm スクリプトがシェル依存になるため。
const suiteArg = process.argv.find((a) => a.startsWith('--suite='))
const suite = suiteArg ? suiteArg.slice('--suite='.length) : 'gpu'
const headed = process.argv.includes('--headed')

const aliasMap = JSON.parse(readFileSync(join(repoRoot, 'build/aliases.json'), 'utf8'))
const alias = Object.fromEntries(
  Object.entries(aliasMap).map(([key, value]) => [key, resolve(repoRoot, value)]),
)

let server = null
const lines = []

const say = (m) => {
  lines.push(m)
  console.log(m)
}

const finish = (payload) => {
  const results = payload.results ?? []
  const failed = results.filter((r) => !r.ok)
  const skipped = results.filter((r) => r.skipped)
  const passed = results.filter((r) => r.ok && !r.skipped)

  say('')
  say(`================ ${suite.toUpperCase()} ================`)
  say(`passed: ${passed.length}  failed: ${failed.length}  skipped: ${skipped.length}`)
  for (const f of failed) {
    say('')
    say(`FAILED: ${f.name}`)
    say(f.error ?? '(no detail)')
  }
  if (payload.fatal) say(`FATAL: ${payload.fatal}`)
  say('==============================================')

  const code = failed.length === 0 && !payload.fatal && results.length > 0 ? 0 : 1
  void server?.close().finally(() => app.exit(code))
  setTimeout(() => app.exit(code), 3000)
}

ipcMain.on('harness:log', (_e, m) => say(m))
ipcMain.on('harness:report', (_e, payload) => finish(payload))

app.whenReady().then(async () => {
  server = await createServer({
    configFile: false,
    root: repoRoot,
    resolve: { alias },
    server: { port: 0, strictPort: false },
    // 依存の事前バンドルはテスト起動を遅くするだけなので抑える
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: 'warn',
  })
  await server.listen()
  const address = server.httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const window = new BrowserWindow({
    width: 1000,
    height: 700,
    show: headed,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 非表示のままでも rAF を回す必要がある (PC008 で有効性を確認済み)
      backgroundThrottling: false,
    },
  })

  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') say(`  [renderer:error] ${event.message}`)
  })

  const url = `http://localhost:${String(port)}/test/harness/runner.html?suite=${suite}`
  say(`harness: ${url}`)
  await window.loadURL(url)

  // 応答がないまま固まった場合の保険
  setTimeout(() => {
    say('TIMEOUT: harness did not report within 120s')
    void server?.close().finally(() => app.exit(1))
  }, 120_000)
})

app.on('window-all-closed', () => app.exit(1))
