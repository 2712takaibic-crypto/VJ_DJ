import * as THREE from 'three/webgpu'
import { createChromaKeyMaterial, type ChromaKeyMaterial, type ChromaKeyParams } from './chroma'

/**
 * ステージ上の被写体。
 *
 * green_back の映像をクロマキーで抜いて 3D 空間の板に貼る。
 *
 * 素材の制約:
 *   596×336 / 28.96 秒 / 29.97fps。曲 (90.48 秒) より短いのでループする。
 *   解像度が低いため板を大きくしすぎると粗が見える。
 *   さらに被写体の脚が素材の下端で切れているので、
 *   足元は床の光やヘイズで隠す構図にする必要がある。
 */

export type Performer = {
  readonly object: THREE.Object3D
  readonly keyMaterial: ChromaKeyMaterial
  /** 板の高さ (メートル)。アスペクト比は素材から決まる */
  setHeight(meters: number): void
  dispose(): void
}

export const createPerformer = (
  texture: THREE.Texture,
  sourceWidth: number,
  sourceHeight: number,
  keyParams: Partial<ChromaKeyParams> = {},
  heightMeters = 4.6,
): Performer => {
  const keyMaterial = createChromaKeyMaterial(texture, keyParams)

  const geometry = new THREE.PlaneGeometry(1, 1)
  const mesh = new THREE.Mesh(geometry, keyMaterial.material)
  const group = new THREE.Group()
  group.add(mesh)

  const aspect = sourceWidth / sourceHeight

  const applyHeight = (meters: number): void => {
    mesh.scale.set(meters * aspect, meters, 1)
    // 板の下端を y=0 に置く
    mesh.position.y = meters / 2
  }
  applyHeight(heightMeters)

  return {
    object: group,
    keyMaterial,
    setHeight: applyHeight,
    dispose: () => {
      geometry.dispose()
      keyMaterial.dispose()
    },
  }
}
