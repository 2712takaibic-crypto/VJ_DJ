/**
 * 書き出しの制御。Engine Host (レンダラ) と main プロセスの間で使う。
 *
 * フレームはレンダラ側で JPEG に圧縮してから送る。
 * 1920x1080 の生 RGBA は 1 枚 8.3MB あり、90 秒 30fps では
 * 合計 22GB を IPC で運ぶことになる。JPEG なら 1 枚 300KB 程度で済む。
 *
 * JPEG は非可逆なので、この後の H.264 エンコードと合わせて
 * 二重の圧縮になる。MV の用途では実用上問題にならないが、
 * 完全に劣化を避けたい場合は PNG に変えること (容量と速度は犠牲になる)。
 */

export type ExportConfig = {
  readonly outputPath: string
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly durationSeconds: number
  /** 開始時刻。画作りの確認で途中だけ書き出すのに使う */
  readonly startSeconds: number
  /** 多重化する音声ファイル。省略すると無音 */
  readonly audioPath: string | null
  /** H.264 の品質。小さいほど高品質 (18〜28 が実用域) */
  readonly crf: number
}

export type ExportProgress = {
  readonly frame: number
  readonly totalFrames: number
  readonly elapsedSeconds: number
}

export type ExportResult =
  | {
      readonly ok: true
      readonly outputPath: string
      readonly frames: number
      readonly elapsedSeconds: number
    }
  | { readonly ok: false; readonly error: string }
