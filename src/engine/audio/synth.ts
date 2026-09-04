/**
 * 簡易シンセ。
 *
 * plan.txt の「打ち込みやシーケンサーで曲を作れる DAW 機能」のうち、
 * 音源にあたる部分。素材がなくても打ち込みを試せるようにする。
 *
 * 減算方式: オシレータ 2 基 → フィルタ → アンプ。
 * VST は対象外なので (設計書 §4.4)、音源は自前で用意する必要がある。
 *
 * **発音は必ず `when` を指定して予約する。**
 * 「今すぐ鳴らす」で組むと JS のタイマー精度に引きずられてヨレる。
 */

export type SynthVoiceKind = 'kick' | 'snare' | 'hat' | 'bass' | 'lead'

export type Synth = {
  readonly output: GainNode
  /** 指定の音声時刻に発音する */
  trigger(kind: SynthVoiceKind, when: number, velocity: number, semitone?: number): void
  dispose(): void
}

/** 半音からの周波数。A4=440Hz 基準 */
const noteToFrequency = (semitone: number): number => 440 * Math.pow(2, semitone / 12)

export const createSynth = (context: AudioContext): Synth => {
  const output = context.createGain()
  // 0.8 だとキックとスネアが重なった瞬間に peak が 1.0 を超えて歪む
  // (実測 1.0138)。ヘッドルームを確保する。
  output.gain.value = 0.55

  /** ノイズは毎回作らず 1 本を使い回す。生成コストが無視できないため。 */
  const noiseBuffer = (() => {
    const length = Math.floor(context.sampleRate * 0.5)
    const buffer = context.createBuffer(1, length, context.sampleRate)
    const data = buffer.getChannelData(0)
    // 決定的なノイズ。Math.random を使うと起動ごとに音が変わる。
    let seed = 12345
    for (let i = 0; i < length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      data[i] = (seed / 0xffffffff) * 2 - 1
    }
    return buffer
  })()

  const envelope = (when: number, attack: number, decay: number, peak: number): GainNode => {
    const gain = context.createGain()
    gain.gain.setValueAtTime(0, when)
    gain.gain.linearRampToValueAtTime(peak, when + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay)
    return gain
  }

  const playNoise = (when: number, decay: number, peak: number, filterHz: number): void => {
    const source = context.createBufferSource()
    source.buffer = noiseBuffer
    const filter = context.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = filterHz
    const env = envelope(when, 0.001, decay, peak)
    source.connect(filter)
    filter.connect(env)
    env.connect(output)
    source.start(when)
    source.stop(when + decay + 0.05)
    source.onended = () => {
      source.disconnect()
      filter.disconnect()
      env.disconnect()
    }
  }

  const playTone = (
    when: number,
    frequency: number,
    decay: number,
    peak: number,
    type: OscillatorType,
    sweepTo?: number,
  ): void => {
    const osc = context.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(frequency, when)
    if (sweepTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), when + decay * 0.8)
    }
    const env = envelope(when, 0.002, decay, peak)
    osc.connect(env)
    env.connect(output)
    osc.start(when)
    osc.stop(when + decay + 0.05)
    osc.onended = () => {
      osc.disconnect()
      env.disconnect()
    }
  }

  return {
    output,

    trigger: (kind, when, velocity, semitone = 0) => {
      const level = Math.max(0, Math.min(1, velocity))
      switch (kind) {
        case 'kick':
          // 高い所から一気に落とすとキックになる
          playTone(when, 150, 0.32, level, 'sine', 45)
          return
        case 'snare':
          playNoise(when, 0.18, level * 0.7, 1200)
          playTone(when, 200, 0.12, level * 0.35, 'triangle', 150)
          return
        case 'hat':
          playNoise(when, 0.055, level * 0.35, 7000)
          return
        case 'bass':
          playTone(when, noteToFrequency(semitone - 24), 0.34, level * 0.8, 'sawtooth')
          return
        case 'lead':
          playTone(when, noteToFrequency(semitone), 0.28, level * 0.45, 'square')
          return
      }
    },

    dispose: () => {
      output.disconnect()
    },
  }
}
