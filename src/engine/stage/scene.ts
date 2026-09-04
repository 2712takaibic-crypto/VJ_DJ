import * as THREE from 'three/webgpu'
import { float, uniform, uv, vec2, vec3 } from 'three/tsl'
import { createLaserRig, type LaserRig } from './lasers'
import { createParticleField, type ParticleField } from './particles'

/**
 * バーチャルライブのステージ。
 *
 * 構図の制約:
 *   green_back.mp4 は 596×336 と小さく、さらに被写体の脚が素材の下端で
 *   切れている。そのため被写体は等身大に留め、足元は床の発光で隠し、
 *   周囲を構造物とエフェクトで埋める。
 *
 * 見た目の方針:
 *   すべて暗い色で塗ると「真っ黒に人が浮いている」画になる。
 *   発光する要素 (床のグリッド、LED ウォール、ライトバー、レーザー) で
 *   空間の輪郭を描くこと。bloom がそれを拾って舞台らしくなる。
 */

export type StageAudio = {
  readonly pulse: number
  readonly low: number
  readonly mid: number
  readonly high: number
  readonly rms: number
  readonly onset: number
}

export type Stage = {
  readonly root: THREE.Group
  readonly performerAnchor: THREE.Group
  update(t: number, audio: StageAudio): void
  dispose(): void
}

export const createStage = (): Stage => {
  const root = new THREE.Group()
  const owned: { dispose(): void }[] = []
  const track = <T extends { dispose(): void }>(resource: T): T => {
    owned.push(resource)
    return resource
  }

  // ---------- 床 ----------
  const floorGeometry = track(new THREE.PlaneGeometry(80, 80))
  const floorMaterial = track(
    new THREE.MeshStandardNodeMaterial({ color: 0x07070f, roughness: 0.25, metalness: 0.85 }),
  )
  const floor = new THREE.Mesh(floorGeometry, floorMaterial)
  floor.rotation.x = -Math.PI / 2
  root.add(floor)

  // 発光するグリッド。空間の広がりを示す最も効く要素。
  const gridHelper = new THREE.GridHelper(80, 40, 0x2a6cff, 0x121a3a)
  const gridMaterial = gridHelper.material as THREE.Material
  gridMaterial.transparent = true
  gridMaterial.opacity = 0.32
  gridMaterial.depthWrite = false
  gridHelper.position.y = 0.01
  root.add(gridHelper)
  owned.push(gridMaterial)

  // ---------- 被写体の足元を隠す発光ディスク ----------
  // 素材の脚が下端で切れているので、そこを光で溶かす。
  // 一様な円だと「板が置いてある」ようにしか見えないので、
  // 中心から外へ滑らかに落ちる減衰を持たせる。
  const glowGeometry = track(new THREE.CircleGeometry(3.4, 64))
  const glowMaterial = track(
    new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  )
  const glowStrength = uniform(float(0.5))
  // 中心 1.0 → 外周 0.0 の二乗減衰
  const glowFalloff = uv().sub(vec2(0.5)).length().mul(2).oneMinus().clamp(0, 1).pow(2.2)
  glowMaterial.colorNode = vec3(0.56, 0.78, 1)
  glowMaterial.opacityNode = glowFalloff.mul(glowStrength)
  const footGlow = new THREE.Mesh(glowGeometry, glowMaterial)
  footGlow.rotation.x = -Math.PI / 2
  footGlow.position.y = 0.02
  root.add(footGlow)

  // ---------- 背面の LED ウォール ----------
  const wallBars: THREE.Mesh[] = []
  const wallGeometry = track(new THREE.BoxGeometry(0.55, 7.4, 0.12))
  for (let i = 0; i < 18; i++) {
    const hue = i / 18
    const material = track(
      new THREE.MeshBasicNodeMaterial({
        color: new THREE.Color().setHSL(hue * 0.5 + 0.55, 0.8, 0.35),
        toneMapped: false,
      }),
    )
    const bar = new THREE.Mesh(wallGeometry, material)
    bar.position.set((i - 8.5) * 0.72, 3.9, -8.5)
    root.add(bar)
    wallBars.push(bar)
  }

  // ---------- トラス (縦柱と横梁) ----------
  const trussMaterial = track(
    new THREE.MeshStandardNodeMaterial({ color: 0x2a2a38, roughness: 0.45, metalness: 0.95 }),
  )
  const pillarGeometry = track(new THREE.BoxGeometry(0.22, 10, 0.22))
  for (const x of [-7.6, -5.2, 5.2, 7.6]) {
    const pillar = new THREE.Mesh(pillarGeometry, trussMaterial)
    pillar.position.set(x, 5, -7.2)
    root.add(pillar)
  }
  const beamGeometry = track(new THREE.BoxGeometry(16.2, 0.22, 0.22))
  for (const y of [7.4, 9.4]) {
    const beam = new THREE.Mesh(beamGeometry, trussMaterial)
    beam.position.set(0, y, -7.2)
    root.add(beam)
  }

  // ---------- ライトバー ----------
  const lightBars: THREE.Mesh[] = []
  const barGeometry = track(new THREE.BoxGeometry(1.55, 0.11, 0.11))
  for (let i = 0; i < 8; i++) {
    const hue = i / 8
    const material = track(
      new THREE.MeshBasicNodeMaterial({
        color: new THREE.Color().setHSL(hue, 0.9, 0.5),
        toneMapped: false,
      }),
    )
    const bar = new THREE.Mesh(barGeometry, material)
    bar.position.set((i - 3.5) * 2.05, 7.1, -6.8)
    root.add(bar)
    lightBars.push(bar)
  }

  // ---------- レーザーとパーティクル ----------
  const lasers: LaserRig = createLaserRig()
  root.add(lasers.object)
  const particles: ParticleField = createParticleField()
  root.add(particles.object)

  // ---------- 照明 ----------
  const ambient = new THREE.AmbientLight(0x2c3a58, 0.7)
  root.add(ambient)

  const key = new THREE.SpotLight(0xcfe4ff, 120, 60, Math.PI / 6, 0.45, 1.2)
  key.position.set(0, 10, 7)
  key.target.position.set(0, 1.8, 0)
  root.add(key, key.target)

  const rimLeft = new THREE.SpotLight(0xff3d8b, 90, 50, Math.PI / 6, 0.5, 1.3)
  rimLeft.position.set(-7, 8, -4)
  rimLeft.target.position.set(0, 2, 0)
  root.add(rimLeft, rimLeft.target)

  const rimRight = new THREE.SpotLight(0x2a7bff, 90, 50, Math.PI / 6, 0.5, 1.3)
  rimRight.position.set(7, 8, -4)
  rimRight.target.position.set(0, 2, 0)
  root.add(rimRight, rimRight.target)

  const performerAnchor = new THREE.Group()
  root.add(performerAnchor)

  return {
    root,
    performerAnchor,

    update: (t, audio) => {
      // ライトバー: 1 本ずつ位相をずらして波が走るように
      for (const [index, bar] of lightBars.entries()) {
        const material = bar.material as THREE.MeshBasicNodeMaterial
        const wave = Math.max(0, Math.sin(t * 3.1 - index * 0.55))
        const level = 0.18 + audio.pulse * 0.75 + wave * 0.35 * audio.low
        material.color.setHSL((index / 8 + t * 0.03) % 1, 0.9, Math.min(0.85, 0.2 + level * 0.6))
        bar.rotation.z = Math.sin(t * 0.7 + index * 0.5) * 0.2
      }

      // LED ウォール: 中低域で下から立ち上がるバー表現
      for (const [index, bar] of wallBars.entries()) {
        const material = bar.material as THREE.MeshBasicNodeMaterial
        const band = Math.abs(Math.sin(index * 0.9 + t * 2.2))
        const level = audio.mid * 0.6 + audio.low * 0.5 * band + audio.pulse * 0.35
        material.color.setHSL((0.58 + index * 0.012 + t * 0.02) % 1, 0.85, 0.12 + level * 0.5)
        bar.scale.y = 0.35 + level * 0.9
      }

      // 足元の発光: 低音で広がる
      glowStrength.value = 0.45 + audio.low * 0.55 + audio.pulse * 0.35
      footGlow.scale.setScalar(0.9 + audio.low * 0.3)

      lasers.update(t, 0.35 + audio.high * 0.5 + audio.pulse * 0.5, 0.9)
      particles.update(t, audio.rms)

      // 照明を揺らす
      key.position.x = Math.sin(t * 0.33) * 2.6
      key.intensity = 90 + audio.rms * 90
      // 左右で反応をずらすと、平板に見えない
      rimLeft.intensity = 60 + audio.pulse * 120
      rimRight.intensity = 60 + audio.high * 100 + (1 - audio.pulse) * 40
    },

    dispose: () => {
      lasers.dispose()
      particles.dispose()
      for (const resource of owned) resource.dispose()
      owned.length = 0
    },
  }
}
