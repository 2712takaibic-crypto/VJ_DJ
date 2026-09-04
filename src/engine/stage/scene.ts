import * as THREE from 'three/webgpu'
import { float, uniform, uv, vec2, vec3 } from 'three/tsl'
import { createLaserRig, type LaserRig } from './lasers'
import { createBurstField, EXPLOSION, SPARK, type BurstField } from './bursts'
import { createLightningRig, type LightningRig } from './lightning'
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
  /** 現在の拍番号 (整数)。電撃の形状を決定的に生成するのに使う */
  readonly beatIndex: number
  /** 拍内の位相 0〜1 */
  readonly beatPhase: number
  /** 1 拍の秒数。バーストの寿命計算に使う */
  readonly beatInterval: number
}

export type StageControls = {
  readonly lasers: { readonly intensity: number; readonly sweep: number; readonly enabled: boolean }
  readonly wall: { readonly hue: number; readonly hueRange: number; readonly brightness: number }
  readonly particles: { readonly enabled: boolean; readonly intensity: number }
  readonly lightning: { readonly enabled: boolean; readonly intensity: number }
  readonly bursts: { readonly enabled: boolean; readonly intensity: number }
}

export type Stage = {
  readonly root: THREE.Group
  readonly performerAnchor: THREE.Group
  update(t: number, audio: StageAudio, controls: StageControls, camera: THREE.Camera): void
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
  const wallGeometry = track(new THREE.BoxGeometry(0.62, 8.6, 0.12))
  for (let i = 0; i < 24; i++) {
    const hue = i / 18
    const material = track(
      new THREE.MeshBasicNodeMaterial({
        color: new THREE.Color().setHSL(hue * 0.5 + 0.55, 0.8, 0.35),
        toneMapped: false,
      }),
    )
    const bar = new THREE.Mesh(wallGeometry, material)
    bar.position.set((i - 11.5) * 0.78, 4.4, -7.6)
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
  const lightning: LightningRig = createLightningRig()
  root.add(lightning.object)

  // fx-editor の explosion / spark プリセットを参考にしたバースト
  const explosions: BurstField = createBurstField({ style: EXPLOSION, slots: 3, everyBeats: 8 })
  root.add(explosions.object)
  const sparks: BurstField = createBurstField({
    style: SPARK,
    slots: 4,
    everyBeats: 4,
    spread: 9,
    height: 2.2,
  })
  root.add(sparks.object)

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

    update: (t, audio, controls, camera) => {
      // ライトバー: 1 本ずつ位相をずらして波が走るように
      for (const [index, bar] of lightBars.entries()) {
        const material = bar.material as THREE.MeshBasicNodeMaterial
        const wave = Math.max(0, Math.sin(t * 3.1 - index * 0.55))
        const level = 0.18 + audio.pulse * 0.75 + wave * 0.35 * audio.low
        material.color.setHSL((index / 8 + t * 0.03) % 1, 0.9, Math.min(0.85, 0.2 + level * 0.6))
        bar.rotation.z = Math.sin(t * 0.7 + index * 0.5) * 0.2
      }

      // LED ウォール: スペクトラムアナライザ風に、バーごとに高さと明るさを変える。
      //
      // 色相を時間で一周させると黄緑など不利な色に来て、
      // 被写体が沈む。シアン〜紫〜マゼンタの範囲で往復させる。
      const wallHue = controls.wall.hue + Math.sin(t * 0.07) * controls.wall.hueRange
      for (const [index, bar] of wallBars.entries()) {
        const material = bar.material as THREE.MeshBasicNodeMaterial
        const band = Math.abs(Math.sin(index * 0.8 + t * 2.1))
        const level = audio.mid * 0.5 + audio.low * 0.45 * band + audio.pulse * 0.3
        // 中央付近を暗くして、被写体の背後が抜けるようにする
        const centreBias = Math.min(1, Math.abs(index - (wallBars.length - 1) / 2) / 5)
        material.color.setHSL(
          (wallHue + index * 0.006) % 1,
          0.85,
          (0.05 + level * 0.26) * (0.35 + centreBias * 0.65) * controls.wall.brightness,
        )
        bar.scale.y = 0.3 + level * 0.85
      }

      // 足元の発光: 低音で広がる
      glowStrength.value = 0.45 + audio.low * 0.55 + audio.pulse * 0.35
      footGlow.scale.setScalar(0.9 + audio.low * 0.3)

      lasers.object.visible = controls.lasers.enabled
      if (controls.lasers.enabled) {
        lasers.update(
          t,
          (0.35 + audio.high * 0.5 + audio.pulse * 0.5) * controls.lasers.intensity,
          controls.lasers.sweep,
        )
      }
      particles.object.visible = controls.particles.enabled
      if (controls.particles.enabled) {
        particles.update(t, audio.rms * controls.particles.intensity)
      }

      const burstsOn = controls.bursts.enabled
      explosions.object.visible = burstsOn
      sparks.object.visible = burstsOn
      if (burstsOn) {
        const burstEnergy = Math.min(
          1,
          (audio.rms * 0.7 + audio.onset * 0.5) * controls.bursts.intensity,
        )
        explosions.update(audio.beatIndex, audio.beatPhase, audio.beatInterval, burstEnergy, camera)
        sparks.update(audio.beatIndex, audio.beatPhase, audio.beatInterval, burstEnergy, camera)
      }

      lightning.object.visible = controls.lightning.enabled
      if (controls.lightning.enabled) {
        lightning.update(
          t,
          audio.beatIndex,
          audio.beatPhase,
          Math.min(1, (audio.onset * 0.7 + audio.rms * 0.5) * controls.lightning.intensity),
          camera,
        )
      }

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
      lightning.dispose()
      explosions.dispose()
      sparks.dispose()
      for (const resource of owned) resource.dispose()
      owned.length = 0
    },
  }
}
