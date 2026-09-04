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
  /** vjdj-media:// で参照できる URL */
  readonly url: string
  readonly importedAt: string
}
