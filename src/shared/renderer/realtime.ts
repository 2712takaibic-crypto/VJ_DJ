import type { ShowParams, ShowParamsPatch } from '@shared/protocol/show-params'

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
