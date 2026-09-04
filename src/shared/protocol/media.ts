/**
 * 取り込み済みメディアの記述。
 *
 * main が生成し、UI とエンジンが読む。
 * DOM に依存させないこと (main の tsconfig からも参照される)。
 */
export type MediaKind = 'audio' | 'video' | 'image'

export type MediaAsset = {
  readonly id: string
  readonly kind: MediaKind
  readonly name: string
  readonly sourcePath: string
  readonly durationSeconds: number
  readonly width: number
  readonly height: number
  readonly fps: number
  /** vjdj-media:// で参照できる URL。映像は展開先、音声は解析 JSON */
  readonly url: string
  /** 音声の実体。DJ デッキで鳴らすのに使う。音声以外は null */
  readonly audioUrl: string | null
  readonly importedAt: string
}
