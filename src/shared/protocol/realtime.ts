/**
 * RealtimeChannel: Control Window ⇄ Engine Host を直結する高頻度チャネル。
 *
 * main プロセスを経由しない (設計書 §1.1 設計判断 B)。
 * main はポートの仲介のみを行い、以降のやり取りには関与しない。
 *
 * ここを流れるメッセージは揮発であり、Undo の対象にならない。
 * 永続化が必要な変更は ProjectChannel (Command) を使うこと。
 *
 * P0-3 時点ではハンドシェイクのみ。設計書 §4.2 の全メッセージは
 * 実装するタスクごとに追加していく (型だけ先に置くと実装と乖離するため)。
 */

/** preload が主ワールドへポートを渡すときの封筒。contextBridge を通せないため window.postMessage を使う。 */
export const PORT_ENVELOPE = '__vjdj:realtime-port'

export type PortEnvelope = { readonly [PORT_ENVELOPE]: true }

export const isPortEnvelope = (value: object | null): value is PortEnvelope =>
  value !== null && PORT_ENVELOPE in value

export type ControlToEngine = {
  readonly t: 'hello'
  readonly seq: number
}

export type EngineToControl = {
  readonly t: 'hello-ack'
  readonly seq: number
  /** Engine 側の performance.timeOrigin。両レンダラの時間軸を突き合わせる際の基準になる。 */
  readonly timeOrigin: number
}
