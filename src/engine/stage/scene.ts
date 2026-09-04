import * as THREE from 'three/webgpu'

/**
 * バーチャルライブのステージ。
 *
 * 素材の制約から構図を決めている:
 *   green_back.mp4 は 596×336 と小さいため、1080p 出力で全画面に引き伸ばすと確実に眠くなる。
 *   被写体はステージ中央の等身大サイズに留め、周囲を 3D の構造物とエフェクトで埋める。
 */

export type Stage = {
  readonly root: THREE.Group
  /** 被写体 (クロマキー後の映像) を貼る板。位置とサイズはここで管理する */
  readonly performerAnchor: THREE.Group
  /** ビートに反応させるライトバー */
  readonly lightBars: readonly THREE.Mesh[]
  /** 客席側のスポットライト。ビームの根元になる */
  readonly rigAnchors: readonly THREE.Object3D[]
  update(elapsedSeconds: number): void
  dispose(): void
}

const disposables: { dispose(): void }[] = []

const track = <T extends { dispose(): void }>(resource: T): T => {
  disposables.push(resource)
  return resource
}

export const createStage = (): Stage => {
  const root = new THREE.Group()

  // --- 床 ---
  // 鏡面反射させると一気にライブ会場らしくなる。
  const floorGeometry = track(new THREE.PlaneGeometry(60, 60))
  const floorMaterial = track(
    new THREE.MeshStandardNodeMaterial({
      color: 0x05050c,
      roughness: 0.18,
      metalness: 0.9,
    }),
  )
  const floor = new THREE.Mesh(floorGeometry, floorMaterial)
  floor.rotation.x = -Math.PI / 2
  root.add(floor)

  // --- 背面のトラス風の柱 ---
  const pillarGeometry = track(new THREE.BoxGeometry(0.18, 9, 0.18))
  const pillarMaterial = track(
    new THREE.MeshStandardNodeMaterial({ color: 0x14141c, roughness: 0.6, metalness: 0.8 }),
  )
  for (let i = -4; i <= 4; i++) {
    if (i === 0) continue
    const pillar = new THREE.Mesh(pillarGeometry, pillarMaterial)
    pillar.position.set(i * 2.1, 4.5, -6)
    root.add(pillar)
  }

  // --- ライトバー (ビート反応) ---
  const lightBars: THREE.Mesh[] = []
  const barGeometry = track(new THREE.BoxGeometry(1.7, 0.09, 0.09))
  for (let i = 0; i < 8; i++) {
    const hue = i / 8
    const material = track(
      new THREE.MeshStandardNodeMaterial({
        color: new THREE.Color().setHSL(hue, 0.85, 0.55),
        emissive: new THREE.Color().setHSL(hue, 0.9, 0.5),
        emissiveIntensity: 1.2,
        roughness: 0.3,
      }),
    )
    const bar = new THREE.Mesh(barGeometry, material)
    const x = (i - 3.5) * 2.1
    bar.position.set(x, 6.4, -5.6)
    root.add(bar)
    lightBars.push(bar)
  }

  // --- ビームの根元になるリグ ---
  const rigAnchors: THREE.Object3D[] = []
  for (let i = 0; i < 6; i++) {
    const anchor = new THREE.Object3D()
    const angle = (i / 6) * Math.PI * 2
    anchor.position.set(Math.cos(angle) * 7.5, 7.2, Math.sin(angle) * 7.5 - 1)
    root.add(anchor)
    rigAnchors.push(anchor)
  }

  // --- 照明 ---
  const ambient = new THREE.AmbientLight(0x223044, 0.35)
  root.add(ambient)

  const key = new THREE.SpotLight(0x88bbff, 40, 40, Math.PI / 7, 0.4, 1.4)
  key.position.set(0, 9, 6)
  key.target.position.set(0, 1.6, 0)
  root.add(key, key.target)

  const rim = new THREE.SpotLight(0xff4499, 30, 40, Math.PI / 6, 0.5, 1.4)
  rim.position.set(-6, 7, -5)
  rim.target.position.set(0, 1.6, 0)
  root.add(rim, rim.target)

  // --- 被写体を置く場所 ---
  // 実体 (映像を貼った板) は chroma key 側で作って addChild する。
  const performerAnchor = new THREE.Group()
  performerAnchor.position.set(0, 0, 0)
  root.add(performerAnchor)

  return {
    root,
    performerAnchor,
    lightBars,
    rigAnchors,

    update: (elapsedSeconds) => {
      // 常時ゆっくり動かしておくと、静止画に見えない
      for (const [index, bar] of lightBars.entries()) {
        bar.rotation.z = Math.sin(elapsedSeconds * 0.7 + index * 0.5) * 0.25
      }
      key.position.x = Math.sin(elapsedSeconds * 0.35) * 2.5
      rim.position.x = -6 + Math.cos(elapsedSeconds * 0.28) * 2
    },

    dispose: () => {
      for (const resource of disposables) resource.dispose()
      disposables.length = 0
    },
  }
}
