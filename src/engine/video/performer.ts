import * as THREE from 'three/webgpu'
import { createChromaKeyMaterial, type ChromaKeyMaterial, type ChromaKeyParams } from './chroma'

/**
 * ステージ上の被写体。
 *
 * green_back.mp4 を再生し、クロマキーで抜いて 3D 空間の板に貼る。
 *
 * 素材の制約:
 *   596×336 / 28.96 秒 / 29.97fps。曲 (90.46 秒) より短いのでループする。
 *   解像度が低いため、板を大きくしすぎると粗が見える。
 *   ステージ中央に等身大で置き、周囲を 3D 構造物と FX で埋める構図にする。
 *
 * NOTE: 現状は HTMLVideoElement を使っている。リアルタイムの見た目確認には
 * これで十分だが、**書き出しの決定性は満たせない** (フレーム単位のシークが保証されない)。
 * 書き出し経路では WebCodecs によるフレーム供給に差し替える。
 * そのため映像ソースは `PerformerSource` として抽象化してある。
 */

export type PerformerSource = {
  readonly texture: THREE.Texture
  readonly width: number
  readonly height: number
  play(): Promise<void>
  pause(): void
  /** 秒位置を指定する。ループは呼び出し側で解決済みの値を渡す */
  seek(seconds: number): void
  currentTime(): number
  duration(): number
  dispose(): void
}

export const createVideoElementSource = async (url: string): Promise<PerformerSource> => {
  const video = document.createElement('video')
  video.src = url
  video.loop = true
  video.muted = true
  video.playsInline = true
  video.crossOrigin = 'anonymous'
  video.preload = 'auto'

  await new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      reject(new Error(`failed to load video: ${url} (${video.error?.message ?? 'unknown'})`))
    }
    const cleanup = (): void => {
      video.removeEventListener('loadeddata', onReady)
      video.removeEventListener('error', onError)
    }
    video.addEventListener('loadeddata', onReady)
    video.addEventListener('error', onError)
  })

  const texture = new THREE.VideoTexture(video)
  texture.colorSpace = THREE.SRGBColorSpace
  // クロマキーは画素値をそのまま比較するので、補間で色が混ざると
  // 輪郭に中間色が生まれてマットが甘くなる。ここは線形補間のままとし、
  // 甘さは inner/outer の閾値で調整する。
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false

  return {
    texture,
    width: video.videoWidth,
    height: video.videoHeight,
    play: () => video.play(),
    pause: () => {
      video.pause()
    },
    seek: (seconds) => {
      video.currentTime = seconds
    },
    currentTime: () => video.currentTime,
    duration: () => video.duration,
    dispose: () => {
      video.pause()
      video.removeAttribute('src')
      video.load()
      texture.dispose()
    },
  }
}

export type Performer = {
  readonly object: THREE.Object3D
  readonly source: PerformerSource
  readonly keyMaterial: ChromaKeyMaterial
  /** 板の高さ (メートル)。アスペクト比は素材から自動で決まる */
  setHeight(meters: number): void
  dispose(): void
}

export const createPerformer = (
  source: PerformerSource,
  keyParams: Partial<ChromaKeyParams> = {},
  heightMeters = 3.2,
): Performer => {
  const keyMaterial = createChromaKeyMaterial(source.texture, keyParams)

  const geometry = new THREE.PlaneGeometry(1, 1)
  const mesh = new THREE.Mesh(geometry, keyMaterial.material)
  // 板の原点を足元にする。ステージ床 (y=0) に立たせるため。
  const group = new THREE.Group()
  group.add(mesh)

  const aspect = source.width / source.height

  const applyHeight = (meters: number): void => {
    mesh.scale.set(meters * aspect, meters, 1)
    mesh.position.y = meters / 2
  }
  applyHeight(heightMeters)

  return {
    object: group,
    source,
    keyMaterial,
    setHeight: applyHeight,
    dispose: () => {
      geometry.dispose()
      keyMaterial.dispose()
      source.dispose()
    },
  }
}
