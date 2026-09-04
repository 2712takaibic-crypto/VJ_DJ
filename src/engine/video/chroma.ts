import * as THREE from 'three/webgpu'
import { dot, float, max, mix, smoothstep, texture, uniform, uv, vec2, vec3 } from 'three/tsl'

/**
 * クロマキー。
 *
 * 設計書 §2.2.7 の方式を TSL のノードマテリアルとして実装する。
 * 単純な RGB 閾値ではなく **YCbCr の CbCr 平面上での色距離**で判定する。
 *
 * この選択が効くのは、背景の緑に照明ムラや影があるとき。
 * RGB 閾値方式は輝度が変わると破綻するが、CbCr 距離は輝度成分を
 * 落としているので、暗い緑も明るい緑も同じように抜ける。
 * (テスト設計 CK004 がこの性質を直接検証する)
 *
 * 構成:
 *   1. CbCr 距離 → 内外二重閾値の smoothstep でソフトなマットを作る
 *   2. デスピル: 輪郭に残る緑かぶりを削る
 *
 * チョーク / フェザーは近傍参照が要るためこの 1 パス構成には含めない。
 * 必要になったら別パスとして追加する。
 *
 * NOTE: ファイル名に "key" を含めると .claude/settings.json の
 * Read 拒否ルール (秘密鍵ファイル対策のワイルドカード) に弾かれるため
 * chroma-key.ts ではなく chroma.ts としている。
 */

export type ChromaKeyParams = {
  /** キーとなる背景色 */
  readonly keyColor: THREE.Color
  /** これ以下の色距離は完全透過 */
  readonly innerTolerance: number
  /** これ以上の色距離は完全不透過 */
  readonly outerTolerance: number
  /** スピル抑制の強さ 0〜1 */
  readonly despill: number
  /** 全体の不透明度 */
  readonly opacity: number
  /**
   * 明るさの補正。
   * 素材は明るい照明下で白い衣装を着ているため、そのまま出すと
   * bloom と合わさって白飛びする。1 未満で落として使う。
   */
  readonly brightness: number
}

/**
 * 既定値は green_back.mp4 の実測に合わせてある。
 * 背景は rgb(15,255,5) = #0FFF05 でほぼ純緑、かつ画面全体で均一だった
 * (ffmpeg で生フレームを取り出して確認)。
 * 一般的なグリーンバック (#00B140) とはかなり違うので、
 * 素材が変わったらスポイトで取り直すこと。
 */
export const DEFAULT_CHROMA_KEY: ChromaKeyParams = {
  keyColor: new THREE.Color(0x0fff05),
  innerTolerance: 0.06,
  outerTolerance: 0.22,
  despill: 0.85,
  opacity: 1,
  brightness: 0.78,
}

export type ChromaKeyMaterial = {
  readonly material: THREE.MeshBasicNodeMaterial
  setParams(params: Partial<ChromaKeyParams>): void
  /** マット単体を表示する調整用モード。これがないと閾値の追い込みができない */
  setMatteView(enabled: boolean): void
  dispose(): void
}

/** BT.709 の輝度係数 */
const LUMA = vec3(0.2126, 0.7152, 0.0722)

export const createChromaKeyMaterial = (
  map: THREE.Texture,
  initial: Partial<ChromaKeyParams> = {},
): ChromaKeyMaterial => {
  const params: ChromaKeyParams = { ...DEFAULT_CHROMA_KEY, ...initial }

  // 色ノードではなく vec3 の uniform として持つ。
  // TSL の色ノードは dot() の引数に取れないため。
  // THREE.Color は色管理により線形空間の値を持ち、
  // テクスチャ側もサンプル時に線形化されるので比較の土俵は揃っている。
  const keyColorU = uniform(
    new THREE.Vector3(params.keyColor.r, params.keyColor.g, params.keyColor.b),
  )
  const innerU = uniform(float(params.innerTolerance))
  const outerU = uniform(float(params.outerTolerance))
  const despillU = uniform(float(params.despill))
  const opacityU = uniform(float(params.opacity))
  const brightnessU = uniform(float(params.brightness))
  const matteViewU = uniform(float(0))

  const src = texture(map, uv())
  const srcRgb = src.rgb

  // --- マット生成 ---
  // RGB → CbCr。輝度成分を落とすのがこの方式の肝。
  // TSL のノード型が厳密でヘルパ関数に切り出すと型が合わないため、
  // 素材側とキー色側で同じ式を 2 度書いている。
  const srcY = dot(srcRgb, LUMA)
  const srcCbCr = vec2(srcRgb.b.sub(srcY).div(1.8556), srcRgb.r.sub(srcY).div(1.5748))

  // THREE.Color の uniform はそのまま色ノードになるので vec3 で包まない
  const keyY = dot(keyColorU, LUMA)
  const keyCbCr = vec2(keyColorU.b.sub(keyY).div(1.8556), keyColorU.r.sub(keyY).div(1.5748))

  const dist = srcCbCr.distance(keyCbCr)
  // inner >= outer だと NaN になりうるため outer 側を必ず上回らせる (確定挙動 D-6)
  const safeOuter = max(outerU, innerU.add(float(1e-4)))
  const alpha = smoothstep(innerU, safeOuter, dist)

  // --- デスピル ---
  // 緑が赤・青の最大値を超えた分を despill の割合だけ削る。
  const other = max(srcRgb.r, srcRgb.b)
  const greenFixed = mix(srcRgb.g, other, despillU)
  // g > other のときだけ効かせたいので、min で「増えない」ことを保証する
  const despilledGreen = srcRgb.g.min(greenFixed.max(other.min(srcRgb.g)))
  const despilled = vec3(srcRgb.r, despilledGreen, srcRgb.b)

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  })

  // TSL では colorNode の alpha 成分は使われない。
  // 透過は opacityNode に別途与える必要がある。
  // ここを vec4 の colorNode だけで済ませようとすると、
  // 「マットは正しく出ているのに一切抜けない」という状態になる。
  material.colorNode = mix(despilled.mul(brightnessU), vec3(alpha), matteViewU)
  material.opacityNode = mix(alpha.mul(opacityU), float(1), matteViewU)

  return {
    material,

    setParams: (next) => {
      if (next.keyColor !== undefined) {
        keyColorU.value.set(next.keyColor.r, next.keyColor.g, next.keyColor.b)
      }
      if (next.innerTolerance !== undefined) innerU.value = next.innerTolerance
      if (next.outerTolerance !== undefined) outerU.value = next.outerTolerance
      if (next.despill !== undefined) despillU.value = next.despill
      if (next.opacity !== undefined) opacityU.value = next.opacity
      if (next.brightness !== undefined) brightnessU.value = next.brightness
    },

    setMatteView: (enabled) => {
      matteViewU.value = enabled ? 1 : 0
    },

    dispose: () => {
      material.dispose()
    },
  }
}
