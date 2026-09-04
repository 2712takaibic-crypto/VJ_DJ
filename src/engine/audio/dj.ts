import { createAudioEngine, type AudioEngine } from './engine'
import { createMixer, type CrossfaderCurve, type Mixer, type MixerState } from './mixer'
import { createSampler, type Sampler, type SamplerPad } from './sampler'
import { createSequencer, type Sequencer, type SequencerState } from './sequencer'
import { createSynth, type Synth } from './synth'

/**
 * DJ セクション全体。
 *
 * plan.txt の「音のサンプリング、ミキシングなど、DJ 用機能一式」に対応する。
 *
 * 音声の読み込みは fetch + decodeAudioData。
 * ライブラリが取り込み時に音源をキャッシュへ複製しているので、
 * `vjdj-media://` 経由でそのまま取得できる。
 */

export type DjState = {
  readonly ready: boolean
  readonly mixer: MixerState
  readonly pads: readonly SamplerPad[]
  readonly level: number
  readonly sequencer: SequencerState
}

export type Dj = {
  readonly engine: AudioEngine
  readonly mixer: Mixer
  readonly sampler: Sampler
  readonly synth: Synth
  readonly sequencer: Sequencer
  /** デッキへ曲を読み込む */
  loadDeck(deck: 'A' | 'B', url: string, name: string, bpm: number | null): Promise<void>
  /** サンプラーのパッドへ音を割り当てる */
  loadPad(index: number, url: string, name: string): Promise<void>
  setCrossfader(value: number): void
  setCurve(curve: CrossfaderCurve): void
  setMasterGain(value: number): void
  getState(): DjState
  dispose(): Promise<void>
}

const decode = async (context: AudioContext, url: string): Promise<AudioBuffer> => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`failed to fetch audio: ${url}`)
  return context.decodeAudioData(await response.arrayBuffer())
}

export const createDj = (): Dj => {
  const engine = createAudioEngine()
  const mixer = createMixer(engine.context, engine.master)
  const sampler = createSampler(engine.context)
  sampler.output.connect(engine.master)
  const synth = createSynth(engine.context)
  synth.output.connect(engine.master)
  const sequencer = createSequencer(engine.context, synth, sampler)

  let masterGain = 0.9

  return {
    engine,
    mixer,
    sampler,
    synth,
    sequencer,

    loadDeck: async (deck, url, name, bpm) => {
      const buffer = await decode(engine.context, url)
      const target = deck === 'A' ? mixer.deckA : mixer.deckB
      target.load(name, buffer, bpm)
    },

    loadPad: async (index, url, name) => {
      const buffer = await decode(engine.context, url)
      sampler.assign(index, name, buffer)
    },

    setCrossfader: (value) => {
      mixer.setCrossfader(value)
    },

    setCurve: (curve) => {
      mixer.setCurve(curve)
    },

    setMasterGain: (value) => {
      masterGain = value
      engine.setMasterGain(value)
    },

    getState: () => ({
      ready: engine.isReady(),
      mixer: mixer.getState(masterGain),
      pads: sampler.listPads(),
      level: engine.getLevel(),
      sequencer: sequencer.getState(),
    }),

    dispose: async () => {
      sequencer.dispose()
      synth.dispose()
      sampler.dispose()
      mixer.dispose()
      await engine.dispose()
    },
  }
}
