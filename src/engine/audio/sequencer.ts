import type { Sampler } from './sampler'
import type { Synth, SynthVoiceKind } from './synth'

/**
 * ステップシーケンサー。
 *
 * plan.txt の「打ち込みやシーケンサーで曲を作れる DAW 機能」に対応する。
 *
 * **先読みスケジューリングで組む** (設計書 §2.2.3)。
 * 25ms 間隔のタイマーで 100ms 先までのステップを Web Audio へ予約する。
 * 「タイマーが鳴った瞬間に音を出す」方式にすると JS のタイマー精度
 * (数ms〜数十ms のばらつき) がそのままヨレになる。
 * Web Audio はサンプル精度で発音時刻を予約できるので、それを使う。
 *
 * 音源は内蔵シンセかサンプラーのパッド。VST は対象外 (設計書 §4.4)。
 */

export type SequencerTrack = {
  readonly name: string
  /** 内蔵シンセの音色。null ならサンプラーのパッドを使う */
  readonly voice: SynthVoiceKind | null
  /** サンプラーのパッド番号。voice が null のとき使う */
  readonly pad: number | null
  /** ステップごとの velocity。0 は休符 */
  readonly steps: readonly number[]
  readonly muted: boolean
}

export type SequencerState = {
  readonly playing: boolean
  readonly bpm: number
  readonly stepsPerBar: number
  readonly currentStep: number
  readonly tracks: readonly SequencerTrack[]
}

export type Sequencer = {
  start(): void
  stop(): void
  setBpm(bpm: number): void
  /** ステップを切り替える。velocity 0 で消音 */
  setStep(track: number, step: number, velocity: number): void
  setMuted(track: number, muted: boolean): void
  getState(): SequencerState
  dispose(): void
}

const LOOKAHEAD_MS = 25
const SCHEDULE_AHEAD_SECONDS = 0.1

const DEFAULT_TRACKS: readonly SequencerTrack[] = [
  { name: 'KICK', voice: 'kick', pad: null, steps: Array<number>(16).fill(0), muted: false },
  { name: 'SNARE', voice: 'snare', pad: null, steps: Array<number>(16).fill(0), muted: false },
  { name: 'HAT', voice: 'hat', pad: null, steps: Array<number>(16).fill(0), muted: false },
  { name: 'BASS', voice: 'bass', pad: null, steps: Array<number>(16).fill(0), muted: false },
  { name: 'LEAD', voice: 'lead', pad: null, steps: Array<number>(16).fill(0), muted: false },
  { name: 'PAD 1', voice: null, pad: 0, steps: Array<number>(16).fill(0), muted: false },
]

export const createSequencer = (
  context: AudioContext,
  synth: Synth,
  sampler: Sampler,
): Sequencer => {
  const stepsPerBar = 16
  const tracks: SequencerTrack[] = DEFAULT_TRACKS.map((track) => ({
    ...track,
    steps: [...track.steps],
  }))

  let bpm = 130
  let playing = false
  let nextStep = 0
  let nextStepTime = 0
  let timer: ReturnType<typeof setInterval> | null = null

  /** 16 分音符 1 つぶんの秒数 */
  const stepDuration = (): number => 60 / bpm / 4

  const scheduleStep = (step: number, when: number): void => {
    for (const track of tracks) {
      if (track.muted) continue
      const velocity = track.steps[step] ?? 0
      if (velocity <= 0) continue

      if (track.voice !== null) {
        // ベースとリードは音程を持たせる。1 小節の中で動くと打ち込みらしくなる。
        const semitone = track.voice === 'bass' ? ([0, 0, 7, 5][step % 4] ?? 0) : (step % 8) * 2
        synth.trigger(track.voice, when, velocity, semitone)
      } else if (track.pad !== null) {
        sampler.trigger(track.pad, when, velocity)
      }
    }
  }

  const tick = (): void => {
    if (!playing) return
    // 100ms 先までのステップを予約する。
    // ここで予約しておけば、次のタイマーが多少遅れても音はずれない。
    while (nextStepTime < context.currentTime + SCHEDULE_AHEAD_SECONDS) {
      scheduleStep(nextStep, nextStepTime)
      nextStepTime += stepDuration()
      nextStep = (nextStep + 1) % stepsPerBar
    }
  }

  return {
    start: () => {
      if (playing) return
      playing = true
      nextStep = 0
      // 少し先から始める。現在時刻ちょうどだと最初の音が間に合わない。
      nextStepTime = context.currentTime + 0.05
      timer = setInterval(tick, LOOKAHEAD_MS)
      tick()
    },

    stop: () => {
      playing = false
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },

    setBpm: (next) => {
      bpm = Math.max(40, Math.min(240, next))
    },

    setStep: (trackIndex, step, velocity) => {
      const track = tracks[trackIndex]
      if (track === undefined || step < 0 || step >= stepsPerBar) return
      const steps = [...track.steps]
      steps[step] = Math.max(0, Math.min(1, velocity))
      tracks[trackIndex] = { ...track, steps }
    },

    setMuted: (trackIndex, muted) => {
      const track = tracks[trackIndex]
      if (track === undefined) return
      tracks[trackIndex] = { ...track, muted }
    },

    getState: () => ({
      playing,
      bpm,
      stepsPerBar,
      // 予約済みの先を指しているので、鳴っている位置は 1 つ手前
      currentStep: playing ? (nextStep + stepsPerBar - 1) % stepsPerBar : 0,
      tracks: tracks.map((track) => ({ ...track, steps: [...track.steps] })),
    }),

    dispose: () => {
      playing = false
      if (timer !== null) clearInterval(timer)
      timer = null
    },
  }
}
