/** ウィンドウの役割。preload には `--vjdj-role=` 引数として渡る。 */
export type WindowRole = 'control' | 'engine'

export const ROLE_ARG_PREFIX = '--vjdj-role='

export const isWindowRole = (value: string): value is WindowRole =>
  value === 'control' || value === 'engine'

export type DisplayInfo = {
  readonly id: number
  readonly label: string
  readonly bounds: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  /**
   * OS の拡大縮小率。2 画面目が 1.5 倍などになっている環境があるため
   * (PoC 結果 §PC001 の実測)、出力ウィンドウの canvas バッキングストアは
   * この値を掛けて決める必要がある。
   */
  readonly scaleFactor: number
  readonly isPrimary: boolean
}
