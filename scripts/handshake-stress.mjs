/**
 * S001-R: 起動とウィンドウ構成の安定性テスト
 *
 * RealtimeChannel のポート配布は Electron でレースが起きやすい箇所であり、
 * 1 回成功しただけでは何も保証できない。
 * アプリを N 回起動し、毎回ハンドシェイクが成立することを確認する。
 *
 * 実行:
 *   npm run test:handshake            (100 回)
 *   HANDSHAKE_RUNS=20 npm run test:handshake
 *
 * 前提: `npm run build` 済みであること。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const RUNS = Number(process.env['HANDSHAKE_RUNS'] ?? '100')
const RUN_TIMEOUT_MS = 40_000

const runOnce = (index) =>
  new Promise((resolve) => {
    const child = spawn(electronPath, ['.'], {
      env: { ...process.env, VJDJ_SELFTEST: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (out += String(d)))

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ index, ok: false, rttMs: null, reason: 'timeout', out })
    }, RUN_TIMEOUT_MS)

    child.on('exit', (code) => {
      clearTimeout(timer)
      const match = /SELFTEST PASS rtt=([\d.]+)ms/.exec(out)
      if (code === 0 && match) {
        resolve({ index, ok: true, rttMs: Number(match[1]), reason: null, out })
      } else {
        const fail = /SELFTEST FAIL ([^\n]*)/.exec(out)
        resolve({
          index,
          ok: false,
          rttMs: null,
          reason: fail ? fail[1] : `exit=${String(code)}`,
          out,
        })
      }
    })
  })

const quantile = (sorted, q) => {
  if (sorted.length === 0) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[i]
}

const main = async () => {
  console.log(`S001-R: handshake stress — ${RUNS} runs`)
  const failures = []
  const rtts = []
  const startedAt = Date.now()

  for (let i = 1; i <= RUNS; i++) {
    // 並列に起動すると GPU / ウィンドウマネージャで競合し、
    // 計測したいレース以外の要因で落ちるため逐次実行する。
    const result = await runOnce(i)
    if (result.ok) {
      rtts.push(result.rttMs)
    } else {
      failures.push(result)
    }
    const mark = result.ok ? '.' : 'X'
    process.stdout.write(mark)
    if (i % 50 === 0) process.stdout.write(` ${String(i)}\n`)
  }
  if (RUNS % 50 !== 0) process.stdout.write('\n')

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  const sorted = [...rtts].sort((a, b) => a - b)

  console.log('')
  console.log('================ S001-R ================')
  console.log(`runs      : ${String(RUNS)} in ${elapsed}s`)
  console.log(`passed    : ${String(rtts.length)}`)
  console.log(`failed    : ${String(failures.length)}`)
  if (sorted.length > 0) {
    console.log(
      `rtt (ms)  : p50=${quantile(sorted, 0.5).toFixed(2)} ` +
        `p95=${quantile(sorted, 0.95).toFixed(2)} ` +
        `p99=${quantile(sorted, 0.99).toFixed(2)} ` +
        `max=${sorted[sorted.length - 1].toFixed(2)}`,
    )
  }
  for (const f of failures.slice(0, 5)) {
    console.log(`--- failure #${String(f.index)}: ${f.reason}`)
    console.log(
      f.out
        .split('\n')
        .filter((l) => l.trim() && !l.includes('Security Warning') && !l.includes('electronjs.org'))
        .slice(-6)
        .join('\n'),
    )
  }
  console.log('========================================')

  process.exit(failures.length === 0 ? 0 : 1)
}

await main()
