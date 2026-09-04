import type { ExportConfig, ExportResult } from './export'
import type { MediaAsset } from './media'
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

  /** 書き出しを開始する。ffmpeg を起動して受け入れ状態にする */
  exportBegin(config: ExportConfig): Promise<void>
  /** JPEG に圧縮済みの 1 フレームを渡す */
  exportFrame(jpeg: Uint8Array): Promise<void>
  /** 書き出しを終了して結果を得る */
  exportFinish(): Promise<ExportResult>
  /**
   * main から書き出し指示が出ているかを問い合わせる。
   * VJDJ_EXPORT で起動した場合に設定が返る。
   */
  exportRequest(): Promise<ExportConfig | null>

  /** ファイル選択ダイアログを開き、選ばれたファイルを取り込む */
  importMedia(): Promise<readonly MediaAsset[]>
  /** 取り込み済みのメディア一覧 */
  listMedia(): Promise<readonly MediaAsset[]>
}
