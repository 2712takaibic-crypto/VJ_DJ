/**
 * DJ デッキ。
 *
 * 1 曲を読み込んで再生し、テンポ・音量・EQ を操作する。
 *
 * **キーロックは実装していない。**
 * `playbackRate` を変えるとピッチも一緒に変わる。
 * ピッチを保ったままテンポだけ変えるには signalsmith-stretch を
 * AudioWorklet で回す必要があり、別途取り組む (要件 F-D1)。
 * 現状は「レコードのピッチフェーダー」と同じ挙動になる。
 *
 * 再生位置は **開始時の (音声時刻, 曲位置) のアンカーから逆算する。**
 * 経過を加算していくと浮動小数の誤差が蓄積し、長い曲でずれる
 * (設計書 §2.2.3 と同じ考え方)。
 */

export type DeckState = {
  readonly loaded: boolean
  readonly name: string
  readonly playing: boolean
  readonly positionSeconds: number
  readonly durationSeconds: number
  readonly rate: number
  readonly gain: number
  readonly eq: { readonly low: number; readonly mid: number; readonly high: number }
  readonly bpm: number | null
}

export type Deck = {
  readonly id: string
  /** ミキサーへ繋ぐ出力 */
  readonly output: GainNode
  load(name: string, buffer: AudioBuffer, bpm: number | null): void
  play(): void
  pause(): void
  seek(seconds: number): void
  setRate(rate: number): void
  setGain(gain: number): void
  /** EQ はデシベル。-30 で実質キル */
  setEq(band: 'low' | 'mid' | 'high', db: number): void
  getState(): DeckState
  dispose(): void
}

export const createDeck = (id: string, context: AudioContext): Deck => {
  const output = context.createGain()
  output.gain.value = 1

  // 3 バンド EQ。DJ ミキサーの定番構成。
  const low = context.createBiquadFilter()
  low.type = 'lowshelf'
  low.frequency.value = 200

  const mid = context.createBiquadFilter()
  mid.type = 'peaking'
  mid.frequency.value = 1000
  mid.Q.value = 0.8

  const high = context.createBiquadFilter()
  high.type = 'highshelf'
  high.frequency.value = 4000

  const trim = context.createGain()
  trim.gain.value = 1

  low.connect(mid)
  mid.connect(high)
  high.connect(trim)
  trim.connect(output)

  let buffer: AudioBuffer | null = null
  let name = ''
  let bpm: number | null = null
  let source: AudioBufferSourceNode | null = null

  let playing = false
  let rate = 1
  // アンカー: この音声時刻に、曲のこの位置にいた
  let anchorAudioTime = 0
  let anchorPosition = 0

  const positionNow = (): number => {
    if (buffer === null) return 0
    if (!playing) return anchorPosition
    const elapsed = (context.currentTime - anchorAudioTime) * rate
    const raw = anchorPosition + elapsed
    // ループ再生。DJ 用途では曲末で止まるより繋がる方が扱いやすい。
    return ((raw % buffer.duration) + buffer.duration) % buffer.duration
  }

  const stopSource = (): void => {
    if (source === null) return
    try {
      source.stop()
    } catch {
      // すでに停止済み。無視してよい。
    }
    source.disconnect()
    source = null
  }

  const startSource = (offset: number): void => {
    if (buffer === null) return
    stopSource()
    const next = context.createBufferSource()
    next.buffer = buffer
    next.loop = true
    next.playbackRate.value = rate
    next.connect(low)
    next.start(0, offset % buffer.duration)
    source = next
    anchorAudioTime = context.currentTime
    anchorPosition = offset
  }

  return {
    id,
    output,

    load: (nextName, nextBuffer, nextBpm) => {
      const wasPlaying = playing
      stopSource()
      buffer = nextBuffer
      name = nextName
      bpm = nextBpm
      anchorPosition = 0
      anchorAudioTime = context.currentTime
      if (wasPlaying) startSource(0)
    },

    play: () => {
      if (buffer === null || playing) return
      playing = true
      startSource(anchorPosition)
    },

    pause: () => {
      if (!playing) return
      anchorPosition = positionNow()
      playing = false
      stopSource()
    },

    seek: (seconds) => {
      if (buffer === null) return
      const clamped = ((seconds % buffer.duration) + buffer.duration) % buffer.duration
      anchorPosition = clamped
      anchorAudioTime = context.currentTime
      if (playing) startSource(clamped)
    },

    setRate: (nextRate) => {
      const clamped = Math.max(0.5, Math.min(2, nextRate))
      // レートを変える前に現在位置でアンカーを打ち直す。
      // 打ち直さないと、変更前の経過に新しいレートが適用されて位置が飛ぶ。
      anchorPosition = positionNow()
      anchorAudioTime = context.currentTime
      rate = clamped
      if (source !== null) {
        source.playbackRate.setTargetAtTime(clamped, context.currentTime, 0.02)
      }
    },

    setGain: (value) => {
      trim.gain.setTargetAtTime(Math.max(0, Math.min(2, value)), context.currentTime, 0.01)
    },

    setEq: (band, db) => {
      const clamped = Math.max(-30, Math.min(12, db))
      const filter = band === 'low' ? low : band === 'mid' ? mid : high
      filter.gain.setTargetAtTime(clamped, context.currentTime, 0.02)
    },

    getState: () => ({
      loaded: buffer !== null,
      name,
      playing,
      positionSeconds: positionNow(),
      durationSeconds: buffer?.duration ?? 0,
      rate,
      gain: trim.gain.value,
      eq: { low: low.gain.value, mid: mid.gain.value, high: high.gain.value },
      // レートを変えると実効 BPM も変わる
      bpm: bpm === null ? null : bpm * rate,
    }),

    dispose: () => {
      stopSource()
      low.disconnect()
      mid.disconnect()
      high.disconnect()
      trim.disconnect()
      output.disconnect()
    },
  }
}
