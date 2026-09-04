import * as THREE from 'three/webgpu'

/**
 * 舞い上がるパーティクル。
 *
 * 位置は「時刻の純関数」として GPU 側で計算する。
 * CPU で位置を積分すると、シークしたときや書き出し直したときに
 * 結果が変わってしまい、決定性が崩れる。
 *
 * 各粒子は初期位置と速度だけを属性として持ち、
 * 実際の位置は `初期位置 + 速度 * t` を高さで折り返して求める。
 * これなら任意の時刻へ直接ジャンプできる。
 */

export type ParticleField = {
  readonly object: THREE.Object3D
  update(t: number, intensity: number): void
  dispose(): void
}

export type ParticleOptions = {
  readonly count?: number
  readonly area?: number
  readonly ceiling?: number
}

export const createParticleField = (options: ParticleOptions = {}): ParticleField => {
  const count = options.count ?? 2400
  const area = options.area ?? 26
  const ceiling = options.ceiling ?? 12

  const positions = new Float32Array(count * 3)
  const speeds = new Float32Array(count)
  const phases = new Float32Array(count)
  const sizes = new Float32Array(count)

  // 疑似乱数。決定的に生成したいので Math.random は使わない。
  let seed = 20260905
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0xffffffff
  }

  for (let i = 0; i < count; i++) {
    positions[i * 3] = (random() - 0.5) * area
    positions[i * 3 + 1] = random() * ceiling
    positions[i * 3 + 2] = (random() - 0.5) * area - 2
    speeds[i] = 0.25 + random() * 0.9
    phases[i] = random() * Math.PI * 2
    sizes[i] = 0.02 + random() * 0.07
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1))

  const material = new THREE.PointsNodeMaterial({
    color: new THREE.Color(0xbfd8ff),
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
    toneMapped: false,
  })
  material.size = 0.06

  const points = new THREE.Points(geometry, material)

  // 位置の更新は CPU で行うが、t の純関数として毎回まるごと計算し直す。
  // 差分を積み上げないので、どの時刻へ飛んでも同じ結果になる。
  const basePositions = positions.slice()
  const attribute = geometry.getAttribute('position') as THREE.BufferAttribute

  return {
    object: points,

    update: (t, intensity) => {
      const array = attribute.array as Float32Array
      for (let i = 0; i < count; i++) {
        const baseY = basePositions[i * 3 + 1] ?? 0
        const rise = (baseY + t * (speeds[i] ?? 0.5)) % ceiling
        array[i * 3 + 1] = rise
        // 横方向はゆっくり漂わせる
        const sway = Math.sin(t * 0.4 + (phases[i] ?? 0)) * 0.35
        array[i * 3] = (basePositions[i * 3] ?? 0) + sway
      }
      attribute.needsUpdate = true
      material.opacity = 0.25 + intensity * 0.55
    },

    dispose: () => {
      geometry.dispose()
      material.dispose()
    },
  }
}
