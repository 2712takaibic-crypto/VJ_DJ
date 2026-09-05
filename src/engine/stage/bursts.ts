import * as THREE from 'three/webgpu'
import { texture, uniform, uv, vec3 } from 'three/tsl'
import { fxTexture, type FxTextureName } from './fx-textures'

/**
 * ビートで弾けるパーティクルバースト (爆発 / 火花)。
 *
 * 3D_GamingSystem の fx-editor プリセット (explosion.fx.json / spark.fx.json) の
 * 色とサイズの推移を参考にしている。あちらは spawnRate で連続的に生成するが、
 * ここでは**バーストを拍に結び付けた決定的な生成**にしている。
 *
 * 位置は `origin + v*age + 0.5*g*age²` で毎フレーム計算し直す。
 * 速度を積分して積み上げると、シークや再書き出しで結果が変わる。
 * 弾道式なら任意の時刻へ直接飛べる。
 *
 * **InstancedMesh を使う (Points ではない)。**
 * 当初 THREE.Points + PointsNodeMaterial で実装したが、
 * 頂点属性を外し、map を外し、最小構成まで落としても一切描画されなかった。
 * 一方 MeshBasicNodeMaterial に明示的な TSL を書く経路は、
 * クロマキーとレーザーで動作実績がある。
 * 原因究明に時間を使うより、動く経路へ寄せる判断をした。
 */

export type BurstStyle = {
  readonly texture: FxTextureName
  readonly colorStart: THREE.Color
  readonly colorEnd: THREE.Color
  readonly sizeStart: number
  readonly sizeEnd: number
  readonly speed: number
  readonly gravity: number
  /** 1 バーストの寿命 (秒) */
  readonly life: number
  readonly particlesPerBurst: number
}

/** explosion.fx.json 相当。淡黄 → 橙赤へ、大きく広がる */
export const EXPLOSION: BurstStyle = {
  texture: 'glow',
  colorStart: new THREE.Color(0xfff2b0),
  colorEnd: new THREE.Color(0xe23b13),
  sizeStart: 0.22,
  sizeEnd: 1.15,
  speed: 5.2,
  gravity: -1.2,
  life: 0.9,
  particlesPerBurst: 36,
}

/** spark.fx.json 相当。桃白 → 青紫へ、細かく速い */
export const SPARK: BurstStyle = {
  texture: 'spark',
  colorStart: new THREE.Color(0xffd0d0),
  colorEnd: new THREE.Color(0x6b70ff),
  sizeStart: 0.42,
  sizeEnd: 0.1,
  speed: 8,
  gravity: -3.2,
  life: 0.6,
  particlesPerBurst: 30,
}

export type BurstField = {
  readonly object: THREE.Object3D
  update(
    beatIndex: number,
    beatPhase: number,
    interval: number,
    energy: number,
    camera: THREE.Camera,
    placement: {
      readonly origin: { readonly x: number; readonly y: number; readonly z: number }
      readonly spread: number
    },
  ): void
  dispose(): void
}

/** 決定的なハッシュ */
const hash = (a: number, b: number): number => {
  let x = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d)
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39)
  return ((x ^ (x >>> 15)) >>> 0) / 0xffffffff
}

export type BurstOptions = {
  readonly style: BurstStyle
  readonly slots?: number
  /** 何拍ごとに弾けるか。4 なら小節頭 */
  readonly everyBeats?: number
}

export const createBurstField = (options: BurstOptions): BurstField => {
  const style = options.style
  const slots = options.slots ?? 3
  const everyBeats = options.everyBeats ?? 4

  const root = new THREE.Group()
  const map = fxTexture(style.texture)
  const geometry = new THREE.PlaneGeometry(1, 1)

  type Slot = {
    readonly mesh: THREE.InstancedMesh
    readonly material: THREE.MeshBasicNodeMaterial
    /**
     * rgb = 色 / w = 不透明度。
     * uniform ノードの `.value` は型が緩く unknown になるため、
     * **元の Vector4 を保持して直接更新する。**
     * uniform は同じオブジェクトを参照しているので、これで反映される。
     */
    readonly tint: THREE.Vector4
  }

  const slotList: Slot[] = []

  for (let slot = 0; slot < slots; slot++) {
    const tint = new THREE.Vector4(1, 1, 1, 0)
    const tintU = uniform(tint)

    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    })
    // クロマキーと同じ書き方。テクスチャを明示的にサンプルして色と透明度を作る。
    const sampled = texture(map, uv())
    material.colorNode = vec3(tintU.x, tintU.y, tintU.z).mul(sampled.rgb)
    material.opacityNode = sampled.a.mul(tintU.w)

    const mesh = new THREE.InstancedMesh(geometry, material, style.particlesPerBurst)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.frustumCulled = false
    mesh.visible = false
    root.add(mesh)
    slotList.push({ mesh, material, tint })
  }

  const scratchColor = new THREE.Color()
  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const scale = new THREE.Vector3()

  return {
    object: root,

    update: (beatIndex, beatPhase, interval, energy, camera, placement) => {
      // 直近の区切り拍。everyBeats=4 なら小節頭で弾ける。
      const triggerBeat = Math.floor(beatIndex / everyBeats) * everyBeats
      const baseAge = (beatIndex - triggerBeat + beatPhase) * interval

      for (const [slot, entry] of slotList.entries()) {
        const active = hash(triggerBeat, slot * 31 + 5) < 0.6 + energy * 0.4
        // 僅かにずらすと一斉に弾けず、連鎖して見える
        const age = baseAge - slot * 0.05
        const alive = active && age >= 0 && age < style.life

        if (!alive) {
          entry.mesh.visible = false
          continue
        }
        entry.mesh.visible = true

        const lifeRatio = age / style.life
        scratchColor.copy(style.colorStart).lerp(style.colorEnd, lifeRatio)
        // 立ち上がりを速く、終盤で消す。lifeRatio は [0,1) なので負の冪にならない。
        const alpha = Math.min(1, lifeRatio * 10) * (1 - lifeRatio) ** 1.4 * (0.6 + energy * 0.7)
        entry.tint.set(scratchColor.r, scratchColor.g, scratchColor.b, alpha)

        const size = style.sizeStart + (style.sizeEnd - style.sizeStart) * lifeRatio
        scale.set(size, size, 1)

        const originX =
          placement.origin.x + (hash(triggerBeat, slot * 17 + 1) - 0.5) * placement.spread
        const originY = placement.origin.y + hash(triggerBeat, slot * 17 + 2) * 1.6
        const originZ =
          placement.origin.z + (hash(triggerBeat, slot * 17 + 3) - 0.5) * placement.spread * 0.6

        for (let i = 0; i < style.particlesPerBurst; i++) {
          // 球状にばらけさせる。決定的な擬似乱数から方向を作る。
          const u = hash(triggerBeat * 7 + i, slot * 3 + 11) * 2 - 1
          const theta = hash(triggerBeat * 13 + i, slot * 5 + 23) * Math.PI * 2
          const r = Math.sqrt(Math.max(0, 1 - u * u))
          const speed = style.speed * (0.35 + hash(triggerBeat * 19 + i, slot + 41) * 0.85)

          position.set(
            originX + r * Math.cos(theta) * speed * age,
            originY + u * speed * age + 0.5 * style.gravity * age * age,
            originZ + r * Math.sin(theta) * speed * age,
          )
          // 板をカメラへ向ける。全粒子で同じ回転でよい。
          matrix.compose(position, camera.quaternion, scale)
          entry.mesh.setMatrixAt(i, matrix)
        }
        entry.mesh.instanceMatrix.needsUpdate = true
      }
    },

    dispose: () => {
      geometry.dispose()
      for (const entry of slotList) entry.material.dispose()
    },
  }
}
