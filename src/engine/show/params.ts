/**
 * ショーの調整パラメータ。
 *
 * UI からも MCP 経由の AI からも、触れるのはここだけにする。
 * 操作の入口を 1 つにしておかないと、
 * 「UI で変えられるのに AI からは変えられない」が生まれる。
 *
 * plan.txt の「MCP を通して AI のプロンプトで同様の操作ができるように」は
 * この型を外部へ公開することで満たす。
 */

export type ChromaParams = {
  readonly innerTolerance: number
  readonly outerTolerance: number
  readonly despill: number
  readonly choke: number
  readonly brightness: number
  /** マット単体表示。閾値の追い込みに使う */
  readonly matteView: boolean
}

export type PerformerParams = {
  readonly heightMeters: number
  readonly x: number
  readonly z: number
  /** 低音での上下量 */
  readonly bounce: number
}

export type BloomParams = {
  /** 音量で加算される前の基準値 */
  readonly strength: number
  readonly radius: number
  readonly threshold: number
  /** 音への追従量。0 で一定 */
  readonly audioResponse: number
}

export type LaserParams = {
  readonly intensity: number
  readonly sweep: number
  readonly enabled: boolean
}

export type WallParams = {
  /** 色相の中心 (0〜1) */
  readonly hue: number
  /** 色相の振れ幅 */
  readonly hueRange: number
  readonly brightness: number
}

export type CameraParams = {
  /** auto: 小節でショットを切り替える / manual: shotIndex を固定 */
  readonly mode: 'auto' | 'manual'
  readonly shotIndex: number
  /** ショット切り替えの間隔 (小節) */
  readonly barsPerShot: number
}

export type ShowParams = {
  readonly chroma: ChromaParams
  readonly performer: PerformerParams
  readonly bloom: BloomParams
  readonly lasers: LaserParams
  readonly wall: WallParams
  readonly camera: CameraParams
  readonly particles: { readonly enabled: boolean; readonly intensity: number }
}

export const DEFAULT_SHOW_PARAMS: ShowParams = {
  chroma: {
    innerTolerance: 0.06,
    outerTolerance: 0.22,
    despill: 0.92,
    choke: 1.1,
    brightness: 0.78,
    matteView: false,
  },
  performer: { heightMeters: 4.6, x: 0, z: 0, bounce: 0.12 },
  bloom: { strength: 0.45, radius: 0.5, threshold: 0.55, audioResponse: 1 },
  lasers: { intensity: 1, sweep: 0.9, enabled: true },
  wall: { hue: 0.62, hueRange: 0.16, brightness: 1 },
  camera: { mode: 'auto', shotIndex: 0, barsPerShot: 4 },
  particles: { enabled: true, intensity: 1 },
}

/** 部分適用。ネストした階層をまとめて上書きせず、指定された値だけ差し替える */
export type ShowParamsPatch = {
  readonly [K in keyof ShowParams]?: Partial<ShowParams[K]>
}

export const applyParamsPatch = (base: ShowParams, patch: ShowParamsPatch): ShowParams => ({
  chroma: { ...base.chroma, ...patch.chroma },
  performer: { ...base.performer, ...patch.performer },
  bloom: { ...base.bloom, ...patch.bloom },
  lasers: { ...base.lasers, ...patch.lasers },
  wall: { ...base.wall, ...patch.wall },
  camera: { ...base.camera, ...patch.camera },
  particles: { ...base.particles, ...patch.particles },
})
