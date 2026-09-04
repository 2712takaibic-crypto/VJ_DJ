import * as THREE from 'three/webgpu'
import { float, uniform, uv, vec3 } from 'three/tsl'

/**
 * レーザービーム。
 *
 * 実装は「細長い円錐を加算合成で描く」だけ。
 * ボリュメトリックな散乱を真面目に計算する必要はなく、
 * 加算合成 + bloom を通せば暗いステージでは十分にビームに見える。
 *
 * ただし一様な不透明度で描くと**光の筋ではなく樹脂の管に見える**。
 * 光らしく見せるには 2 つの減衰が要る:
 *   1. 根元 → 先端 で薄くなる (空気中で散乱して減衰する見え方)
 *   2. 中心 → 外周 で薄くなる (円筒の縁が硬く出ないように)
 *
 * 加算合成なので depthWrite は切る。切らないと後ろのビームが
 * 手前のビームに隠れて不自然になる。
 */

export type LaserRig = {
  readonly object: THREE.Object3D
  /** `t` から決定的に導出するので、書き出しでも同じ絵になる */
  update(t: number, intensity: number, sweep: number): void
  dispose(): void
}

export type LaserOptions = {
  readonly count?: number
  readonly originHeight?: number
  readonly radius?: number
  readonly length?: number
}

export const createLaserRig = (options: LaserOptions = {}): LaserRig => {
  const count = options.count ?? 14
  const originHeight = options.originHeight ?? 7.8
  const radius = options.radius ?? 6.6
  const length = options.length ?? 20

  const root = new THREE.Group()
  const beams: { pivot: THREE.Group; strength: ReturnType<typeof uniform>; seed: number }[] = []

  // 細く保つ。太いと管に見える。
  const geometry = new THREE.CylinderGeometry(0.015, 0.075, length, 14, 1, true)
  // 根元が原点に来るようずらす (uv.y=1 が根元、uv.y=0 が先端になる)
  geometry.translate(0, -length / 2, 0)

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2
    const hue = ((i / count) * 0.75 + 0.55) % 1

    const strength = uniform(float(0.3))

    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    })

    const color = new THREE.Color().setHSL(hue, 0.85, 0.62)
    // 根元 (uv.y=1) で最も明るく、先端へ向かって落とす
    const alongBeam = uv().y.clamp(0, 1).pow(2.2)
    // 円筒の周方向。中心線から縁へ向かって落とす
    const acrossBeam = uv().x.sub(0.5).abs().mul(2).oneMinus().clamp(0, 1).pow(1.4)

    material.colorNode = vec3(color.r, color.g, color.b)
    material.opacityNode = alongBeam.mul(acrossBeam).mul(strength)

    const mesh = new THREE.Mesh(geometry, material)
    const pivot = new THREE.Group()
    pivot.position.set(Math.cos(angle) * radius, originHeight, Math.sin(angle) * radius - 1.5)
    pivot.add(mesh)
    root.add(pivot)

    beams.push({ pivot, strength, seed: i * 1.7 })
  }

  const materials = beams.map((b) => (b.pivot.children[0] as THREE.Mesh).material as THREE.Material)

  return {
    object: root,

    update: (t, intensity, sweep) => {
      for (const beam of beams) {
        // 各ビームを別位相で振る。全部同じ動きだと機械的に見える。
        const phase = t * sweep + beam.seed
        // ジオメトリは既に -Y へ伸びているので反転しない。
        // 真下だと床に刺さるだけなので、客席側へ傾けて振る。
        beam.pivot.rotation.z = Math.sin(phase * 0.7) * 0.55
        beam.pivot.rotation.x = 0.28 + Math.cos(phase * 0.53) * 0.4
        beam.strength.value = 0.08 + intensity * 0.34
      }
    },

    dispose: () => {
      geometry.dispose()
      for (const material of materials) material.dispose()
    },
  }
}
