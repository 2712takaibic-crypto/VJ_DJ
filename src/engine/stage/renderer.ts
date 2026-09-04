import * as THREE from 'three/webgpu'
import { pass } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'

/**
 * ステージのレンダラ。
 *
 * plan.txt の追記により、合成は 2D レイヤースタックではなく
 * **Three.js の 3D シーン**上で行う方針に変わった。
 * グリーンバックで抜いた被写体を 3D 空間に配置し、
 * レーザー・電撃・パーティクルと合わせてバーチャルライブ風の画を作る。
 *
 * WebGPURenderer を使う。理由は 2 つ。
 *   1. PoC (PC001) で WebGPU の動作を実測済み
 *   2. 流用する FX ライブラリ (3D_GamingSystem/lib/fx-*.js) が
 *      three/webgpu + TSL 前提で書かれている
 */

export type StageRenderer = {
  readonly renderer: THREE.WebGPURenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  /** 出力解像度を設定する。ディスプレイ解像度とは独立 (要件 F-V5) */
  setSize(width: number, height: number): void
  /** 1 フレーム描画する */
  render(): void
  /** ブルームの強さ。曲の盛り上がりに追従させる */
  setBloom(strength: number, radius: number, threshold: number): void
  dispose(): void
}

export type StageRendererOptions = {
  readonly canvas: HTMLCanvasElement
  readonly width: number
  readonly height: number
  /** 2 画面目の scaleFactor が 1.0 でない環境があるため明示的に受ける (PC001 の実測) */
  readonly pixelRatio?: number
}

export const createStageRenderer = async (
  options: StageRendererOptions,
): Promise<StageRenderer> => {
  const renderer = new THREE.WebGPURenderer({
    canvas: options.canvas,
    antialias: true,
    alpha: false,
  })
  await renderer.init()

  renderer.setPixelRatio(options.pixelRatio ?? 1)
  renderer.setSize(options.width, options.height, false)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x03030a)

  const camera = new THREE.PerspectiveCamera(50, options.width / options.height, 0.1, 500)
  camera.position.set(0, 2.2, 9)
  camera.lookAt(0, 1.6, 0)

  // --- ポストプロセス ---
  // 参照された webgl_postprocessing_unreal_bloom は WebGL 版だが、
  // WebGPURenderer では TSL ベースの bloom を使う。
  // r185 で PostProcessing は RenderPipeline に改名された。
  // renderer.init() を await 済みなので render() は同期で呼べる。
  const pipeline = new THREE.RenderPipeline(renderer)
  const scenePass = pass(scene, camera)
  const scenePassColor = scenePass.getTextureNode('output')
  const bloomPass = bloom(scenePassColor, 0.75, 0.55, 0.6)
  pipeline.outputNode = scenePassColor.add(bloomPass)

  return {
    renderer,
    scene,
    camera,

    setSize: (width, height) => {
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    },

    render: () => {
      pipeline.render()
    },

    setBloom: (strength, radius, threshold) => {
      bloomPass.strength.value = strength
      bloomPass.radius.value = radius
      bloomPass.threshold.value = threshold
    },

    dispose: () => {
      pipeline.dispose()
      renderer.dispose()
    },
  }
}
