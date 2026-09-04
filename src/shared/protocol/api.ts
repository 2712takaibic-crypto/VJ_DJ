import type { WindowRole } from './window'

/**
 * preload が contextBridge 経由でレンダラへ公開する API の型。
 *
 * main / preload / レンダラのすべてから参照されるため、
 * **DOM にも Electron にも依存させないこと。**
 * DOM を要する宣言 (Window の拡張など) は src/shared/renderer/ に置く。
 */

export type VersionInfo = {
  readonly electron: string
  readonly chrome: string
  readonly node: string
}

export type VjdjApi = {
  readonly role: WindowRole
  readonly versions: VersionInfo
  /**
   * 主ワールドが message リスナの登録を終えたことを通知し、
   * ポート配布のハンドシェイクを開始する。
   *
   * リスナ登録より先に呼ぶとポートを取りこぼす。
   * 直接呼ばず `connectRealtimePort()` を使うこと。
   */
  ready(): void
}
