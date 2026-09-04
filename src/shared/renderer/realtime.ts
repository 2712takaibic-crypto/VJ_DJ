import type { ShowParams, ShowParamsPatch } from '@shared/protocol/show-params'

/** DJ セクションの状態。UI に表示するために送る */
export type DjDeckPayload = {
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

export type DjStatePayload = {
  readonly ready: boolean
  readonly deckA: DjDeckPayload
  readonly deckB: DjDeckPayload
  readonly crossfader: number
  readonly curve: 'smooth' | 'sharp'
  readonly masterGain: number
  readonly level: number
  readonly pads: readonly { readonly index: number; readonly name: string }[]
  readonly sequencer: SequencerPayload
}

/** シーケンサーの状態 */
export type SequencerPayload = {
  readonly playing: boolean
  readonly bpm: number
  readonly stepsPerBar: number
  readonly currentStep: number
  readonly tracks: readonly {
    readonly name: string
    readonly steps: readonly number[]
    readonly muted: boolean
  }[]
}

/**
 * RealtimeChannel: Control Window ⇄ Engine Host を直結する高頻度チャネル。
 *
 * main プロセスを経由しない (設計書 §1.1 設計判断 B)。
 * main はポートの仲介のみを行い、以降のやり取りには関与しない。
 *
 * ここを流れるメッセージは揮発であり、Undo の対象にならない。
 *
 * プレビューは ImageBitmap を transfer する。
 * PC002 の実測より、この経路はプレビュー解像度に対してほぼ定数コストで、
 * 1080p でも engine 側 0.4ms しかかからない。
 * 生ピクセルの読み戻しは画素数に線形に増える (1080p で 10.8ms)。
 */

/** preload が主ワールドへポートを渡すときの封筒。contextBridge を通せないため window.postMessage を使う。 */
export const PORT_ENVELOPE = '__vjdj:realtime-port'

export type PortEnvelope = { readonly [PORT_ENVELOPE]: true }

export const isPortEnvelope = (value: object | null): value is PortEnvelope =>
  value !== null && PORT_ENVELOPE in value

export type ControlToEngine =
  | { readonly t: 'hello'; readonly seq: number }
  /** パラメータの部分適用。UI のノブを動かしている間に流れる */
  | { readonly t: 'params'; readonly patch: ShowParamsPatch }
  | { readonly t: 'transport'; readonly action: 'play' | 'pause' }
  | { readonly t: 'seek'; readonly seconds: number }
  /** プレビューの受け取り完了通知。背圧制御に使う */
  | { readonly t: 'previewAck'; readonly seq: number }
  | { readonly t: 'previewConfig'; readonly width: number; readonly fps: number }
  /** 被写体の映像を差し替える */
  | { readonly t: 'setVideo'; readonly framesBaseUrl: string }
  /** 音源 (解析結果) を差し替える */
  | { readonly t: 'setAudio'; readonly analysisUrl: string }
  // --- DJ ---
  | {
      readonly t: 'djLoadDeck'
      readonly deck: 'A' | 'B'
      readonly url: string
      readonly name: string
      readonly bpm: number | null
    }
  | { readonly t: 'djDeck'; readonly deck: 'A' | 'B'; readonly action: 'play' | 'pause' }
  | { readonly t: 'djSeek'; readonly deck: 'A' | 'B'; readonly seconds: number }
  | { readonly t: 'djRate'; readonly deck: 'A' | 'B'; readonly rate: number }
  | { readonly t: 'djGain'; readonly deck: 'A' | 'B'; readonly gain: number }
  | {
      readonly t: 'djEq'
      readonly deck: 'A' | 'B'
      readonly band: 'low' | 'mid' | 'high'
      readonly db: number
    }
  | { readonly t: 'djCrossfader'; readonly value: number }
  | { readonly t: 'djCurve'; readonly curve: 'smooth' | 'sharp' }
  | { readonly t: 'djMaster'; readonly value: number }
  | { readonly t: 'djLoadPad'; readonly index: number; readonly url: string; readonly name: string }
  | { readonly t: 'djTriggerPad'; readonly index: number }
  // --- DAW (シーケンサー) ---
  | { readonly t: 'seqTransport'; readonly action: 'start' | 'stop' }
  | { readonly t: 'seqBpm'; readonly bpm: number }
  | {
      readonly t: 'seqStep'
      readonly track: number
      readonly step: number
      readonly velocity: number
    }
  | { readonly t: 'seqMute'; readonly track: number; readonly muted: boolean }

export type EngineToControl =
  | {
      readonly t: 'hello-ack'
      readonly seq: number
      /** Engine 側の performance.timeOrigin。両レンダラの時間軸を突き合わせる基準 */
      readonly timeOrigin: number
    }
  /** 現在の状態。UI の表示を合わせるために定期的に送る */
  | {
      readonly t: 'state'
      readonly params: ShowParams
      readonly timeSeconds: number
      readonly playing: boolean
      readonly duration: number
      readonly bpm: number
      readonly fps: number
    }
  /** プレビュー画像。ImageBitmap は transfer するのでコピーが発生しない */
  | { readonly t: 'preview'; readonly seq: number; readonly bitmap: ImageBitmap }
  /** DJ セクションの状態 */
  | { readonly t: 'djState'; readonly state: DjStatePayload }
