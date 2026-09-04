/**
 * 層 2 (GPU) / 層 3 (音声) 用の最小テスト API。
 *
 * これらは Electron のレンダラ内でしか動かせない (WebGPU / AudioWorklet が要る)。
 * Vitest をレンダラで動かす仕組みを組むより、
 * 必要な機能だけの小さなランナーを持つ方が確実で速い。
 *
 * 層 1 (純ロジック) は通常どおり Vitest を使うこと。こちらを使ってはならない。
 */

export type TestCase = {
  readonly name: string
  readonly fn: () => void | Promise<void>
  readonly skip: boolean
}

const cases: TestCase[] = []

export const test = (name: string, fn: () => void | Promise<void>): void => {
  cases.push({ name, fn, skip: false })
}

test.skip = (name: string, fn: () => void | Promise<void>): void => {
  cases.push({ name, fn, skip: true })
}

export const registeredCases = (): readonly TestCase[] => cases

/**
 * assertion signature にしてあるので、これを通すと型が絞り込まれる。
 * `assert(adapter !== null, ...)` の後で `adapter` が non-null になる。
 * 単なる `(c: boolean) => void` だと絞り込みが効かず、
 * テスト側に不要な `!` や `?.` が増えて読みにくくなる。
 */
export const assert: (condition: boolean, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

export const assertEqual = (
  actual: number | string | boolean,
  expected: number | string | boolean,
  message: string,
): void => {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`)
  }
}

export const assertClose = (
  actual: number,
  expected: number,
  tolerance: number,
  message: string,
): void => {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `${message}\n  expected: ${String(expected)} ±${String(tolerance)}\n  actual:   ${String(actual)}`,
    )
  }
}

/**
 * バイト列の比較。GPU の往復テスト (UP301) やゴールデン画像比較で使う。
 * 最初の不一致だけを報告する — 全部出すとログが読めなくなる。
 */
export const assertBytesClose = (
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
  tolerance: number,
  message: string,
): void => {
  if (actual.length !== expected.length) {
    throw new Error(
      `${message}\n  length mismatch: expected ${String(expected.length)}, got ${String(actual.length)}`,
    )
  }
  let mismatches = 0
  let firstIndex = -1
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i] ?? 0
    const e = expected[i] ?? 0
    if (Math.abs(a - e) > tolerance) {
      mismatches++
      if (firstIndex < 0) firstIndex = i
    }
  }
  if (mismatches > 0) {
    const a = actual[firstIndex] ?? 0
    const e = expected[firstIndex] ?? 0
    throw new Error(
      `${message}\n  ${String(mismatches)}/${String(actual.length)} bytes differ by more than ${String(tolerance)}` +
        `\n  first at [${String(firstIndex)}]: expected ${String(e)}, got ${String(a)}`,
    )
  }
}
