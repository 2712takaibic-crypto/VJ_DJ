/**
 * 時間量の単位型。
 *
 * 本アプリでは tick / 秒 / 音声時刻 / サンプル / フレーム番号が常に併存する。
 * 素の `number` で扱うと取り違えが必ず起きるうえ、
 * 取り違えても動いてしまい、症状が出るのは「30 分再生したら音がずれる」といった
 * 原因の特定しにくい形になる。
 *
 * branded type にしておけば、取り違えは型検査の時点で落ちる。
 * 設計書 §10.2 が「後付けが極めて困難」とした項目の 1 つ。
 */

declare const brand: unique symbol

type Brand<T, B extends string> = T & { readonly [brand]: B }

/**
 * 楽曲内の位置。PPQ=960。負値も取りうる (カウントイン / プリロール用。D-1)。
 *
 * **実数である。**整数に限定していない。
 * 編集操作で保存される値 (クリップ開始位置、キーフレーム時刻、テンポイベント) は
 * 整数に丸めるが、再生ヘッドの位置は連続時間から計算されるため小数になる。
 * 整数が必要な場面では `roundTicks()` を使うこと。
 *
 * **tick 演算に厳密等価を期待してはならない。**
 * `beatsToTicks(ticksToBeats(t)) === t` は浮動小数の都合で成り立たない
 * (誤差は 1e-12 tick 程度 = 120BPM で 1e-15 秒。実害はない)。
 * 比較には必ず許容誤差を使う (テスト設計 TMP01 は 0.5 tick を規定)。
 */
export type Ticks = Brand<number, 'Ticks'>

/** タイムライン原点からの経過秒 */
export type Seconds = Brand<number, 'Seconds'>

/**
 * `AudioContext.currentTime` 系の時刻。
 *
 * `Seconds` とは原点が違う (AudioContext の生成時が 0)。
 * 両者の変換は Transport のアンカーを介してのみ行うこと。
 * 同じ `number` だからと直接混ぜると、そこが同期ずれの発生源になる。
 */
export type AudioTime = Brand<number, 'AudioTime'>

/** `performance.now()` 系の時刻 (ミリ秒) */
export type PerfTime = Brand<number, 'PerfTime'>

export type Samples = Brand<number, 'Samples'>
export type FrameIndex = Brand<number, 'FrameIndex'>
export type Beats = Brand<number, 'Beats'>

/** Pulses Per Quarter note。全ての tick 演算の基準。 */
export const PPQ = 960

export const ticks = (n: number): Ticks => n as Ticks
export const seconds = (n: number): Seconds => n as Seconds
export const audioTime = (n: number): AudioTime => n as AudioTime
export const perfTime = (n: number): PerfTime => n as PerfTime
export const samples = (n: number): Samples => n as Samples
export const frameIndex = (n: number): FrameIndex => n as FrameIndex
export const beats = (n: number): Beats => n as Beats

/** ミリ秒 → 秒。API 境界でよく必要になるのでここに置く。 */
export const msToSeconds = (ms: number): Seconds => seconds(ms / 1000)
export const secondsToMs = (s: Seconds): number => s * 1000

/** tick と拍の相互変換 (テンポに依存しない純粋な換算) */
export const ticksToBeats = (t: Ticks): Beats => beats(t / PPQ)
export const beatsToTicks = (b: Beats): Ticks => ticks(b * PPQ)

/** 保存される位置は整数 tick に丸める。編集操作の確定時に使う。 */
export const roundTicks = (t: Ticks): Ticks => ticks(Math.round(t))

/** tick 比較の既定許容誤差。浮動小数の誤差を吸収する (テスト設計 TMP01)。 */
export const TICK_EPSILON = 0.5

export const ticksNearlyEqual = (a: Ticks, b: Ticks, epsilon = TICK_EPSILON): boolean =>
  Math.abs(a - b) < epsilon
