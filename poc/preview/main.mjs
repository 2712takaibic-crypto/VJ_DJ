/**
 * P0-4 / PC002: プレビュー転送方式の実測
 *
 * 設計書 §2.2.10 は ImageBitmap の transfer を第一候補、
 * copyTextureToBuffer の読み戻しをフォールバックとしている。
 * **両方を同一条件で測り、採用方式を数値で確定させる。**
 *
 * 実行:
 *   npm run poc:preview
 *   POC_SECONDS=60 npm run poc:preview   (テスト設計 §4.3 の正式条件)
 */
import { app, BrowserWindow, MessageChannelMain, ipcMain, screen } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const SECONDS = Number(process.env['POC_SECONDS'] ?? '20')
const PREVIEW_W = Number(process.env['POC_PREVIEW_W'] ?? '480')
const PREVIEW_H = Number(process.env['POC_PREVIEW_H'] ?? '270')

const say = (m) => console.log(m)

const windows = {}
const ready = new Set()

const makeWindow = (role, options) =>
  new BrowserWindow({
    ...options,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      additionalArguments: [`--poc-role=${role}`],
      // ★ 製品と同一の設定で測る
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })

const fmt = (s, digits = 2) =>
  s == null || s.p50 == null
    ? '—'
    : `p50=${s.p50.toFixed(digits)} p95=${s.p95.toFixed(digits)} p99=${s.p99.toFixed(digits)} max=${s.max.toFixed(digits)}`

const finish = (payload) => {
  const r = payload.results
  const outDir = join(repoRoot, '.tmp')
  mkdirSync(outDir, { recursive: true })

  let verdict = 'FAIL'
  let chosen = 'none'
  if (r) {
    // 判定基準 (タスク P0-4): engine 側の追加コスト < 1ms、表示遅延 < 100ms
    const okBitmap = r.bitmap.publishCostMs.p99 < 1 && r.bitmap.latencyMs.p99 < 100
    const okReadback = r.readback.publishCostMs.p99 < 1 && r.readback.latencyMs.p99 < 100
    if (okBitmap) {
      verdict = 'PASS'
      chosen = 'imagebitmap'
    } else if (okReadback) {
      verdict = 'PASS'
      chosen = 'readback'
    }
  }

  writeFileSync(
    join(outDir, 'poc-preview.json'),
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        secondsPerPhase: SECONDS,
        versions: { electron: process.versions.electron, chrome: process.versions.chrome },
        ...payload,
        verdict,
        chosen,
      },
      null,
      2,
    ),
    'utf8',
  )

  say('')
  say('================= PC002 =================')
  say(`verdict: ${verdict}  (採用: ${chosen})`)
  if (r) {
    for (const key of ['baseline', 'bitmap', 'readback']) {
      const p = r[key]
      say('')
      say(`[${p.name}] ${p.fps.toFixed(2)}fps  published=${String(p.published)} acked=${String(p.acked)} skipped=${String(p.skippedByBackpressure)}`)
      say(`  frame interval ms : ${fmt(p.frameIntervalMs)}`)
      if (p.mode !== 'none') {
        say(`  publish cost  ms : ${fmt(p.publishCostMs, 3)}`)
        say(`  latency       ms : ${fmt(p.latencyMs)}`)
        say(`  receiver draw ms : ${fmt(p.receiverDrawMs, 3)}`)
      }
    }
  }
  if (payload.fatal) say(`FATAL: ${payload.fatal}`)
  say('=========================================')

  app.exit(verdict === 'PASS' ? 0 : 1)
}

ipcMain.on('poc:log', (_e, m) => say(`  [engine] ${m}`))
ipcMain.handle('poc:config', () => ({ seconds: SECONDS }))
ipcMain.on('poc:report', (_e, payload) => {
  if (payload.phase === 'done') finish(payload)
})
ipcMain.on('poc:ready', (event) => {
  for (const [role, win] of Object.entries(windows)) {
    if (win.webContents.id === event.sender.id) ready.add(role)
  }
  if (ready.size === 2) {
    const channel = new MessageChannelMain()
    windows.engine.webContents.postMessage('realtime:port', null, [channel.port1])
    windows.control.webContents.postMessage('realtime:port', null, [channel.port2])
    say('  [main] realtime port distributed')
  }
})

app.whenReady().then(async () => {
  const { x, y } = screen.getPrimaryDisplay().workArea

  windows.engine = makeWindow('engine', {
    x: x + 40,
    y: y + 40,
    width: 520,
    height: 560,
    title: 'PoC — Publisher',
  })
  windows.control = makeWindow('control', {
    x: x + 600,
    y: y + 40,
    width: 520,
    height: 400,
    title: 'PoC — Receiver',
  })

  say(`electron=${process.versions.electron} chromium=${process.versions.chrome}`)
  say(`seconds per phase = ${SECONDS}`)
  say('')

  await windows.control.loadFile(join(here, 'control.html'))
  await windows.engine.loadFile(join(here, 'engine.html'), {
    search: `w=${String(PREVIEW_W)}&h=${String(PREVIEW_H)}`,
  })
})

app.on('window-all-closed', () => app.exit(1))
