import { registeredCases } from './api'

/**
 * レンダラ側のテスト実行エントリ。
 * `?suite=gpu` / `?suite=audio` で対象を切り替える。
 */

type HarnessBridge = {
  log(message: string): void
  report(payload: object): void
}

const bridge = (globalThis as { harness?: HarnessBridge }).harness
const say = (m: string): void => {
  bridge?.log(m)
}

const suite = new URLSearchParams(location.search).get('suite') ?? 'gpu'

// Vite の glob は静的なパターンしか受け付けないため、両方を列挙してから絞る。
const loaders = import.meta.glob(['../gpu/**/*.spec.ts', '../audio/**/*.spec.ts'])

const run = async (): Promise<void> => {
  const matched = Object.entries(loaders).filter(([path]) => path.includes(`/${suite}/`))
  for (const [, load] of matched) await load()

  const cases = registeredCases()
  say(`suite=${suite} files=${String(matched.length)} cases=${String(cases.length)}`)

  const results: {
    name: string
    ok: boolean
    skipped: boolean
    ms: number
    error: string | null
  }[] = []

  for (const testCase of cases) {
    if (testCase.skip) {
      results.push({ name: testCase.name, ok: true, skipped: true, ms: 0, error: null })
      say(`  - ${testCase.name} (skipped)`)
      continue
    }
    const started = performance.now()
    try {
      await testCase.fn()
      const ms = performance.now() - started
      results.push({ name: testCase.name, ok: true, skipped: false, ms, error: null })
      say(`  ✓ ${testCase.name} (${ms.toFixed(1)}ms)`)
    } catch (error) {
      const ms = performance.now() - started
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
      results.push({ name: testCase.name, ok: false, skipped: false, ms, error: message })
      say(`  ✗ ${testCase.name}\n${message}`)
    }
  }

  bridge?.report({ suite, results })
}

void run().catch((error: Error) => {
  say(`FATAL ${error.stack ?? error.message}`)
  bridge?.report({ suite, results: [], fatal: error.message })
})
