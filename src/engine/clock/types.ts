import type { AudioTime, PerfTime } from '@shared/units'

/**
 * 時間源の抽象。
 *
 * リアルタイム実装は `AudioContext` を、
 * オフライン実装 (書き出し) は固定タイムステップを供給する。
 * Transport はこの 2 つを区別せずに動く。
 */

/**
 * 音声時刻と performance タイムラインの対応点。
 *
 * `AudioContext.getOutputTimestamp()` が返す
 * 「今スピーカーから出ている音の音声時刻」と「それが起きた実時刻」の組に相当する。
 */
export type Calibration = {
  readonly audioTime: AudioTime
  readonly perfTime: PerfTime
}

export type ClockSource = {
  /** 現在の音声時刻 */
  now(): AudioTime

  /**
   * 音声時刻と performance タイムラインの対応点を返す。
   *
   * **未確立の間は null を返す。**
   *
   * PC003 の実測より: `AudioContext` を `resume()` した直後の
   * `getOutputTimestamp()` は `{contextTime: 0, performanceTime: 0}` を返し、
   * 実際にデバイスがレンダリングを始めるまで約 65ms かかる。
   * この期間の値を基準にアンカーを打つと、**以降ずっと補正されない
   * 定数オフセットが乗る** (実測で 5.5 秒のずれを再現した)。
   *
   * したがって呼び出し側は null を必ず扱うこと。
   * 「とりあえず 0 を使う」は禁止。
   */
  calibrate(): Calibration | null

  /** 較正が確立済みか。false の間は Transport の再生を開始してはならない。 */
  isReady(): boolean

  /** 較正が確立したら解決する。再生開始前に await する。 */
  whenReady(timeoutMs?: number): Promise<void>
}

/**
 * 較正値の平滑化器。
 *
 * PC003 の実測より: 単発の `getOutputTimestamp()` には最大 10ms のジッタが乗る
 * (p50 は 0.003ms と極めて安定しているのに対し max は 10.202ms)。
 *
 * `positionForFrame()` が毎フレーム生の読み取りを使うと、
 * この外れ値がそのまま映像位置の飛びになる。
 * オフセットの推定値をゆっくり更新することで吸収する。
 */
export type CalibrationFilter = {
  /** 新しい観測を取り込み、平滑化後の対応点を返す */
  update(raw: Calibration): Calibration
  /** 平滑化後の現在の推定値。まだ観測がなければ null */
  current(): Calibration | null
  reset(): void
}
