import type { Calibration, ClockSource } from '@engine/clock/types'
import { audioTime, perfTime, type AudioTime } from '@shared/units'

/**
 * テスト用の時計。実時間を一切使わない。
 *
 * Transport のドリフト検証 (TR201: 30 分 / TR202: 2 時間) を
 * ミリ秒で実行するために必須。実時間で待っていたら検証できない。
 *
 * **実機の 2 つの厄介な挙動を再現できるようにしてある** (PC003 の実測より)。
 *   1. 起動直後は較正が確立しない (実機で約 65ms)
 *   2. 較正値には最大 10ms のジッタが乗る
 *
 * この 2 つを模せないと、対策コードが入っているかをテストで確認できない。
 */
export type FakeClockSource = ClockSource & {
  /** 音声時刻を進める。performance 時刻も同量進む (ドリフトなし) */
  advance(seconds: number): void
  /** 音声時刻と performance 時刻を別量進める (ドリフトの注入) */
  advanceSkewed(audioSeconds: number, perfMilliseconds: number): void
  /** 較正を確立させる。呼ぶまで calibrate() は null を返す */
  becomeReady(): void
  /** 次回 1 回だけ calibrate() の perfTime にジッタを乗せる */
  injectJitterOnce(milliseconds: number): void
  /** calibrate() が呼ばれた回数 */
  calibrateCallCount(): number
}

export type FakeClockOptions = {
  /** 初期の音声時刻 */
  readonly startAudioTime?: number
  /** 初期の performance 時刻 (ms) */
  readonly startPerfTime?: number
  /** true なら生成時点で較正済みとして始める */
  readonly readyImmediately?: boolean
}

export const createFakeClockSource = (options: FakeClockOptions = {}): FakeClockSource => {
  let audio = options.startAudioTime ?? 0
  let perf = options.startPerfTime ?? 0
  let ready = options.readyImmediately ?? false
  let jitterOnce = 0
  let calibrateCalls = 0
  const readyWaiters = new Set<() => void>()

  const now = (): AudioTime => audioTime(audio)

  return {
    now,

    calibrate: (): Calibration | null => {
      calibrateCalls++
      if (!ready) return null
      const jitter = jitterOnce
      jitterOnce = 0
      return { audioTime: audioTime(audio), perfTime: perfTime(perf + jitter) }
    },

    isReady: () => ready,

    whenReady: (timeoutMs = 5000) =>
      new Promise<void>((resolve, reject) => {
        if (ready) {
          resolve()
          return
        }
        // 実時間を使わない方針のため、タイムアウトは呼び出し側の責務とする。
        // ここで setTimeout を使うとテストが実時間に依存してしまう。
        void timeoutMs
        const waiter = (): void => {
          resolve()
        }
        readyWaiters.add(waiter)
        if (readyWaiters.size > 1000) reject(new Error('too many whenReady waiters'))
      }),

    advance: (secondsDelta: number) => {
      audio += secondsDelta
      perf += secondsDelta * 1000
    },

    advanceSkewed: (audioSeconds: number, perfMilliseconds: number) => {
      audio += audioSeconds
      perf += perfMilliseconds
    },

    becomeReady: () => {
      ready = true
      for (const waiter of readyWaiters) waiter()
      readyWaiters.clear()
    },

    injectJitterOnce: (milliseconds: number) => {
      jitterOnce = milliseconds
    },

    calibrateCallCount: () => calibrateCalls,
  }
}
