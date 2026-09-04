import * as THREE from 'three/webgpu'
import { float, uniform, uv, vec3 } from 'three/tsl'

/**
 * 電撃エフェクト。
 *
 * plan.txt が要求する「電撃」。ビートに合わせて閃く。
 *
 * 形状はリボン (四角形の帯) で作る。線 (THREE.Line) は太さが 1px 固定で
 * 迫力が出ず、チューブは頂点数が跳ね上がる。
 * リボンをカメラへ向ければ、正面から見るかぎり太さのある稲妻に見える。
 *
 * **形状は拍番号から決定的に生成する。**
 * `Math.random` を使うと書き出しのたびに違う稲妻になり、
 * 「同じプロジェクトから同じ映像が出る」が崩れる。
 */

export type LightningRig = {
  readonly object: THREE.Object3D
  /**
   * @param t          曲頭からの秒数
   * @param beatIndex  現在の拍番号 (整数)
   * @param beatPhase  拍内の位相 0〜1
   * @param energy     0〜1。高いほど発生しやすく明るい
   * @param camera     リボンを向けるカメラ
   */
  update(
    t: number,
    beatIndex: number,
    beatPhase: number,
    energy: number,
    camera: THREE.Camera,
  ): void
  dispose(): void
}

export type LightningOptions = {
  readonly count?: number
  readonly segments?: number
  readonly top?: number
  readonly spread?: number
  readonly width?: number
}

/** 決定的なハッシュ。同じ入力からは必ず同じ値が出る */
const hash = (a: number, b: number): number => {
  let x = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d)
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39)
  return ((x ^ (x >>> 15)) >>> 0) / 0xffffffff
}

export const createLightningRig = (options: LightningOptions = {}): LightningRig => {
  const count = options.count ?? 6
  const segments = options.segments ?? 22
  const top = options.top ?? 9.5
  const spread = options.spread ?? 11
  const width = options.width ?? 0.2

  const root = new THREE.Group()

  type Bolt = {
    readonly group: THREE.Group
    readonly mesh: THREE.Mesh
    readonly positions: Float32Array
    readonly geometry: THREE.BufferGeometry
    readonly strength: ReturnType<typeof uniform>
    /** この稲妻が現在どの拍のために生成されているか */
    builtForBeat: number
  }

  const bolts: Bolt[] = []

  for (let i = 0; i < count; i++) {
    // リボン: セグメントごとに 2 頂点、三角形は 2 枚
    const vertexCount = (segments + 1) * 2
    const positions = new Float32Array(vertexCount * 3)
    const uvs = new Float32Array(vertexCount * 2)
    const indices: number[] = []

    for (let s = 0; s <= segments; s++) {
      const v = s / segments
      uvs[s * 4] = 0
      uvs[s * 4 + 1] = v
      uvs[s * 4 + 2] = 1
      uvs[s * 4 + 3] = v
      if (s < segments) {
        const base = s * 2
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2)
      }
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    geometry.setIndex(indices)

    const strength = uniform(float(0))
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    })
    // 中心が白く、縁が青紫に落ちる断面。これがないと帯が平板に見える。
    const across = uv().x.sub(0.5).abs().mul(2)
    const core = across.oneMinus().clamp(0, 1).pow(1.8)
    material.colorNode = vec3(0.55, 0.75, 1).add(vec3(0.45, 0.25, 0).mul(core))
    material.opacityNode = core.mul(strength)

    const mesh = new THREE.Mesh(geometry, material)
    const group = new THREE.Group()
    group.add(mesh)
    root.add(group)

    bolts.push({ group, mesh, positions, geometry, strength, builtForBeat: -1 })
  }

  /** 拍番号とスロット番号から稲妻の形を作る。同じ入力なら必ず同じ形。 */
  const buildBolt = (bolt: Bolt, beatIndex: number, slot: number): void => {
    const originX = (hash(beatIndex, slot * 7 + 1) - 0.5) * spread
    const originZ = (hash(beatIndex, slot * 7 + 2) - 0.5) * 6 + 1.5
    const driftX = (hash(beatIndex, slot * 7 + 3) - 0.5) * 3.2
    const bottom = 0.2 + hash(beatIndex, slot * 7 + 4) * 1.5

    // **設置位置はグループに、形状は頂点に。**
    // 頂点へ絶対座標を入れたままグループを回すと、
    // 回転中心から離れた頂点が大きく振り回されて画面外へ飛ぶ。
    // ビルボードのためにグループを回すので、頂点は原点近傍に置く。
    bolt.group.position.set(originX, 0, originZ)

    const positions = bolt.positions
    for (let s = 0; s <= segments; s++) {
      const v = s / segments
      // 上から下へ。途中を横に振ってギザギザにする。
      const jitter = (hash(beatIndex * 31 + s, slot) - 0.5) * 1.5 * (1 - v * 0.55)
      const x = driftX * v + jitter
      const y = top + (bottom - top) * v

      // リボンの幅。先端へ向かって細くする。
      const halfWidth = width * (1 - v * 0.6)
      positions[s * 6] = x - halfWidth
      positions[s * 6 + 1] = y
      positions[s * 6 + 2] = 0
      positions[s * 6 + 3] = x + halfWidth
      positions[s * 6 + 4] = y
      positions[s * 6 + 5] = 0
    }
    const attribute = bolt.geometry.getAttribute('position') as THREE.BufferAttribute
    attribute.needsUpdate = true
    bolt.geometry.computeBoundingSphere()
    bolt.builtForBeat = beatIndex
  }

  return {
    object: root,

    update: (t, beatIndex, beatPhase, energy, camera) => {
      void t
      for (const [slot, bolt] of bolts.entries()) {
        // この拍でこのスロットが光るか。
        //
        // 計測すると energy (onset/rms 由来) は 0.05〜0.12 程度しかなく、
        // 確率をこれに任せると発火しない拍が続いて存在感が出ない。
        // **小節頭では高確率で光らせる。**音楽的にもその方が自然。
        const isDownbeat = ((beatIndex % 4) + 4) % 4 === 0
        const roll = hash(beatIndex, slot * 101 + 17)
        const probability = (isDownbeat ? 0.6 : 0.14) + energy * 1.2
        const active = roll < probability

        if (!active) {
          bolt.strength.value = 0
          bolt.group.visible = false
          continue
        }
        bolt.group.visible = true

        if (bolt.builtForBeat !== beatIndex) buildBolt(bolt, beatIndex, slot)

        // 拍頭で最大、急速に消える。稲妻は尾を引かない。
        // 物理的には一瞬だが、30fps で 2 フレームしか出ないと
        // 見た人が認識できない。拍の 1/3 程度まで伸ばす。
        const decay = Math.max(0, 1 - beatPhase * 3)
        // 明滅させると放電らしくなる
        const flicker = 0.65 + 0.35 * Math.sin(beatPhase * 90 + slot)
        bolt.strength.value = decay * flicker * (1.3 + energy * 2.5)

        // リボンをカメラへ向ける。Y 軸まわりのみ回すと稲妻が傾かない。
        const dx = camera.position.x - bolt.group.position.x
        const dz = camera.position.z - bolt.group.position.z
        bolt.group.rotation.y = Math.atan2(dx, dz)
      }
    },

    dispose: () => {
      for (const bolt of bolts) {
        bolt.geometry.dispose()
        ;(bolt.mesh.material as THREE.Material).dispose()
      }
    },
  }
}
