/**
 * P0-5 / PC003: 音声デバイス能力の実測
 *
 * 判定したいこと:
 *   1. ch3/4 への独立出力 (ヘッドホンキュー) が Web Audio 内で成立するか
 *      → 成立しなければ設計書 R-2 のとおりネイティブバックエンドが必要になる
 *   2. AudioWorklet が動くか (signalsmith-stretch の前提)
 *   3. オーディオクロックが Transport のアンカー方式の前提を満たすか
 *
 * 3 は接続機材に依存しないため、オーディオIF が未接続でも意味のある結果が出る。
 * 1 は使用する機材に依存するので、機材を接続して再実行すること。
 *
 * 実行: npm run poc:audio   /   POC_SECONDS=60 npm run poc:audio
 */
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const SECONDS = Number(process.env['POC_SECONDS'] ?? '30')

const say = (m) => console.log(m)

const finish = (payload) => {
  const devices = payload.deviceProbe?.devices ?? []
  const cueCapable = devices.filter((d) => d.supportsIndependentCue)

  const verdict = {
    // AudioWorklet が動かないと Phase 2 以降が成立しない。これは必須。
    worklet: payload.worklet?.ok ? 'PASS' : 'FAIL',
    // クロックの乖離が大きいとアンカー方式の前提が崩れる。
    // 一般的な水晶の精度は数十〜100ppm 程度。1000ppm を超えるなら異常。
    clock:
      payload.clock?.driftPpm != null && Math.abs(payload.clock.driftPpm) < 1000 ? 'PASS' : 'FAIL',
    // キューは接続機材次第。未接続なら「この環境では不可」というだけ。
    cue: cueCapable.length > 0 ? 'PASS' : 'NOT-AVAILABLE',
  }

  const outDir = join(repoRoot, '.tmp')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(
    join(outDir, 'poc-audio.json'),
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        seconds: SECONDS,
        versions: { electron: process.versions.electron, chrome: process.versions.chrome },
        ...payload,
        verdict,
      },
      null,
      2,
    ),
    'utf8',
  )

  say('')
  say('================= PC003 =================')
  say(`AudioWorklet            : ${verdict.worklet}`)
  say(`オーディオクロック       : ${verdict.clock}`)
  say(`ヘッドホンキュー (ch3/4) : ${verdict.cue}`)
  say('')
  say(`出力デバイス ${String(devices.length)} 件:`)
  for (const d of devices) {
    say(`  ${String(d.maxChannelCount ?? '?').padStart(2)}ch  ${d.label}`)
  }
  if (verdict.cue === 'NOT-AVAILABLE') {
    say('')
    say('  → 4ch 以上を報告するデバイスが 1 つもない。')
    say('    この環境ではヘッドホンキューは実現できない。')
    say('    オーディオIF を接続して再実行すること。')
  }
  if (payload.clock) {
    say('')
    const s = payload.clock.startup
    say(
      `クロック: ${String(payload.clock.sampleCount)} サンプル / ` +
        `計測区間 ${((payload.clock.measuredSpanMs ?? 0) / 1000).toFixed(1)}s / ` +
        `最終乖離 ${payload.clock.finalSkewMs?.toFixed(3)}ms / ` +
        `ドリフト ${payload.clock.driftPpm?.toFixed(1)}ppm`,
    )
    if (s) {
      say(
        `  起動: contextTime>0 まで ${s.msUntilRunning?.toFixed(1) ?? '?'}ms / ` +
          `破棄したサンプル ${String(s.discarded)} / ` +
          `初回の読み取り ctx=${String(s.firstReading?.contextTime)} perf=${String(s.firstReading?.performanceTime)}`,
      )
    }
    say(
      `  skew ms: p50=${payload.clock.skewMs.p50?.toFixed(3)} ` +
        `p95=${payload.clock.skewMs.p95?.toFixed(3)} ` +
        `min=${payload.clock.skewMs.min?.toFixed(3)} max=${payload.clock.skewMs.max?.toFixed(3)}`,
    )
  }
  if (payload.fatal) say(`FATAL: ${payload.fatal}`)
  say('=========================================')

  app.exit(verdict.worklet === 'PASS' && verdict.clock === 'PASS' ? 0 : 1)
}

ipcMain.on('poc:log', (_e, m) => say(`  ${m}`))
ipcMain.handle('poc:config', () => ({ seconds: SECONDS }))
ipcMain.on('poc:report', (_e, payload) => {
  if (payload.phase === 'done') finish(payload)
})

app.whenReady().then(async () => {
  // デバイスラベルの取得にはメディア権限が要る
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'midi' || permission === 'midiSysex')
  })

  const window = new BrowserWindow({
    width: 900,
    height: 620,
    title: 'PoC — Audio',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })

  say(`electron=${process.versions.electron} chromium=${process.versions.chrome}`)
  say(`clock probe = ${SECONDS}s`)
  say('')

  await window.loadFile(join(here, 'index.html'))
})

app.on('window-all-closed', () => app.exit(1))
