/**
 * 楽曲解析結果の読み込みと問い合わせ。
 *
 * 解析は scripts/analyze-audio.mjs でオフラインに済ませてある。
 * ここでは JSON を読み、任意の時刻での値を返すだけ。
 * **すべて時刻の純関数**であり、内部状態を持たない。
 *
 * この性質が書き出しの決定性を支えている。
 * 累積で状態を持つと、シークしたときや書き出し直したときに
 * 結果が変わってしまう (設計書 §2.2.12)。
 */

export type EnvelopeName = 'onset' | 'low' | 'mid' | 'high' | 'rms'

export type AnalysisData = {
  readonly durationSeconds: number
  readonly frameRate: number
  readonly tempo: {
    readonly bpm: number
    readonly beatOffsetSeconds: number
  }
  readonly beats: readonly number[]
  readonly envelopes: Readonly<Record<EnvelopeName, readonly number[]>>
}

export type Analysis = {
  readonly data: AnalysisData
  readonly beatIntervalSeconds: number
  /** 拍位置。小数部が拍内の位相になる。曲頭より前は負 */
  beatAt(seconds: number): number
  /** 拍内位相 0〜1 */
  beatPhaseAt(seconds: number): number
  /** 小節位置 (4/4 前提) */
  barAt(seconds: number): number
  /** 直近の拍の番号 */
  beatIndexAt(seconds: number): number
  /** 指定拍の時刻 */
  timeOfBeat(index: number): number
  /** エンベロープの値を線形補間で取得 */
  envelopeAt(name: EnvelopeName, seconds: number): number
  /**
   * 拍のたびに 1 から 0 へ減衰する値。
   * ビートに合わせて光らせる用途に使う。
   * decayBeats で減衰の長さを拍数で指定する。
   */
  beatPulseAt(seconds: number, decayBeats?: number): number
}

const sampleEnvelope = (values: readonly number[], frameRate: number, seconds: number): number => {
  if (values.length === 0) return 0
  const position = seconds * frameRate
  if (position <= 0) return values[0] ?? 0
  if (position >= values.length - 1) return values[values.length - 1] ?? 0
  const index = Math.floor(position)
  const fraction = position - index
  const a = values[index] ?? 0
  const b = values[index + 1] ?? a
  return a + (b - a) * fraction
}

export const createAnalysis = (data: AnalysisData): Analysis => {
  const beatInterval = 60 / data.tempo.bpm
  const offset = data.tempo.beatOffsetSeconds

  const beatAt = (seconds: number): number => (seconds - offset) / beatInterval

  return {
    data,
    beatIntervalSeconds: beatInterval,

    beatAt,

    beatPhaseAt: (seconds) => {
      const beat = beatAt(seconds)
      return beat - Math.floor(beat)
    },

    barAt: (seconds) => beatAt(seconds) / 4,

    beatIndexAt: (seconds) => Math.floor(beatAt(seconds)),

    timeOfBeat: (index) => offset + index * beatInterval,

    envelopeAt: (name, seconds) => sampleEnvelope(data.envelopes[name], data.frameRate, seconds),

    beatPulseAt: (seconds, decayBeats = 1) => {
      const beat = beatAt(seconds)
      const phase = beat - Math.floor(beat)
      if (phase >= decayBeats) return 0
      // 指数減衰。線形だと機械的に見える。
      return Math.exp(-4 * (phase / decayBeats))
    },
  }
}

export const loadAnalysis = async (url: string): Promise<Analysis> => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`analysis not found: ${url}`)
  return createAnalysis((await response.json()) as AnalysisData)
}
