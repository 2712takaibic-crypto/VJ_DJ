import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createFakeClockSource } from '@test/fakes/clock'
import {
  beats,
  beatsToTicks,
  PPQ,
  roundTicks,
  ticks,
  ticksNearlyEqual,
  ticksToBeats,
} from '@shared/units'

describe('units', () => {
  it('PPQ は 960', () => {
    expect(PPQ).toBe(960)
  })

  it('tick と拍を相互変換できる', () => {
    expect(ticksToBeats(ticks(960))).toBe(1)
    expect(ticksToBeats(ticks(3840))).toBe(4)
    expect(beatsToTicks(beats(2))).toBe(1920)
  })

  it('tick ⇄ 拍 の往復が許容誤差内で一致する', () => {
    // 厳密等価は成立しない。(-15365 / 960) * 960 = -15364.999999999998。
    // 誤差は 1e-12 tick 程度で実害はないが、比較には必ず許容誤差を使うこと。
    fc.assert(
      fc.property(fc.integer({ min: -10_000_000, max: 10_000_000 }), (n) => {
        expect(ticksNearlyEqual(beatsToTicks(ticksToBeats(ticks(n))), ticks(n))).toBe(true)
      }),
      { numRuns: 2000 },
    )
  })

  it('roundTicks が保存用の整数位置を返す', () => {
    expect(roundTicks(ticks(959.6))).toBe(960)
    expect(roundTicks(ticks(-15364.999999999998))).toBe(-15365)
  })

  it('負の tick を扱える (D-1: カウントイン用)', () => {
    expect(ticksToBeats(ticks(-960))).toBe(-1)
    expect(beatsToTicks(beats(-2))).toBe(-1920)
  })
})

describe('FakeClockSource', () => {
  it('準備できるまで calibrate() は null を返す', () => {
    // PC003 の実測: 実機では contextTime > 0 になるまで約 65ms かかる。
    // ここで null を返さない実装だと、Transport が不正な基準でアンカーを打つ。
    const clock = createFakeClockSource()
    expect(clock.isReady()).toBe(false)
    expect(clock.calibrate()).toBeNull()

    clock.becomeReady()
    expect(clock.isReady()).toBe(true)
    expect(clock.calibrate()).not.toBeNull()
  })

  it('実時間を使わずに時刻を進められる', () => {
    const clock = createFakeClockSource({ readyImmediately: true })
    expect(clock.now()).toBe(0)
    // 30 分ぶんを一瞬で進める。TR201 のドリフト検証はこれがないと成立しない。
    clock.advance(1800)
    expect(clock.now()).toBe(1800)
  })

  it('音声時刻と performance 時刻を別々に進めてドリフトを注入できる', () => {
    const clock = createFakeClockSource({ readyImmediately: true })
    clock.advanceSkewed(10, 10_010) // 音声 10s に対し実時間 10.01s
    const calibration = clock.calibrate()
    expect(calibration).not.toBeNull()
    expect(calibration?.audioTime).toBe(10)
    expect(calibration?.perfTime).toBe(10_010)
  })

  it('較正値にジッタを 1 回だけ注入できる', () => {
    // PC003 の実測: 単発の読み取りには最大 10ms のジッタが乗る。
    // 平滑化していない実装をこれで落とせるようにしておく。
    const clock = createFakeClockSource({ readyImmediately: true })
    clock.injectJitterOnce(10)
    expect(clock.calibrate()?.perfTime).toBe(10)
    expect(clock.calibrate()?.perfTime).toBe(0)
  })
})
