import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import type { ShowParams, ShowParamsPatch, Vec3 } from '@shared/protocol/show-params'

/**
 * Output ウィンドウ上での直接操作。
 *
 * Control 側のプレビューは転送された画像なのでドラッグできない。
 * 一方 Output ウィンドウは本物の Three.js キャンバスなので、
 * ここでカメラを回し、ギズモでエフェクトの発生位置を掴んで動かせる。
 *
 * 操作した結果は ShowParams へ書き戻す。
 * パラメータを唯一の操作面に保つ方針は崩さない
 * (UI・MCP・ギズモがすべて同じ値を触る)。
 */

export type EditorTarget = 'lasers' | 'lightning' | 'bursts' | 'performer'

export type StageEditor = {
  /** 編集モードの ON/OFF。OFF のときは本番の見た目に戻す */
  setEnabled(enabled: boolean): void
  isEnabled(): boolean
  /** ギズモで掴む対象を切り替える */
  setTarget(target: EditorTarget): void
  getTarget(): EditorTarget
  /** 現在のパラメータをギズモとカメラへ反映する */
  sync(params: ShowParams): void
  /** 毎フレーム呼ぶ */
  update(): void
  /** カメラ操作やギズモの結果を取り出す。変化がなければ null */
  takeChanges(): ShowParamsPatch | null
  dispose(): void
}

const toVec3 = (v: THREE.Vector3): Vec3 => ({
  x: Number(v.x.toFixed(3)),
  y: Number(v.y.toFixed(3)),
  z: Number(v.z.toFixed(3)),
})

export const createStageEditor = (
  camera: THREE.PerspectiveCamera,
  scene: THREE.Scene,
  canvas: HTMLCanvasElement,
): StageEditor => {
  const orbit = new OrbitControls(camera, canvas)
  orbit.enableDamping = true
  orbit.dampingFactor = 0.08
  orbit.target.set(0, 2.3, 0)
  orbit.enabled = false

  // ギズモが掴むためのハンドル。実体のないただの座標。
  const handle = new THREE.Object3D()
  scene.add(handle)

  const gizmo = new TransformControls(camera, canvas)
  gizmo.setMode('translate')
  gizmo.setSize(0.9)
  gizmo.attach(handle)
  gizmo.enabled = false

  // TransformControls は Object3D ではなくヘルパーを返す (r169 以降)
  const gizmoHelper = gizmo.getHelper()
  gizmoHelper.visible = false
  scene.add(gizmoHelper)

  // ギズモを掴んでいる間はカメラを回さない。両方動くと制御できない。
  gizmo.addEventListener('dragging-changed', (event) => {
    orbit.enabled = enabled && !event.value
  })

  let enabled = false
  let target: EditorTarget = 'lasers'
  let dirty = false

  gizmo.addEventListener('objectChange', () => {
    dirty = true
  })
  orbit.addEventListener('change', () => {
    dirty = true
  })

  const originOf = (params: ShowParams): Vec3 => {
    switch (target) {
      case 'lasers':
        return params.lasers.origin
      case 'lightning':
        return params.lightning.origin
      case 'bursts':
        return params.bursts.origin
      case 'performer':
        return { x: params.performer.x, y: 0, z: params.performer.z }
    }
  }

  return {
    setEnabled: (next) => {
      enabled = next
      orbit.enabled = next
      gizmo.enabled = next
      gizmoHelper.visible = next
      if (next) {
        // 現在のカメラ位置から操作を始める
        orbit.object.updateMatrixWorld()
      }
      dirty = true
    },

    isEnabled: () => enabled,

    setTarget: (next) => {
      target = next
      dirty = true
    },

    getTarget: () => target,

    sync: (params) => {
      const origin = originOf(params)
      handle.position.set(origin.x, origin.y, origin.z)
      if (!enabled) {
        // 編集していない間はカメラをショットに任せる。
        // orbit の target だけは追従させ、編集開始時に飛ばないようにする。
        orbit.target.set(params.camera.target.x, params.camera.target.y, params.camera.target.z)
      }
    },

    update: () => {
      if (enabled) orbit.update()
    },

    takeChanges: () => {
      if (!dirty) return null
      dirty = false
      if (!enabled) return null

      const position = toVec3(camera.position)
      const orbitTarget = toVec3(orbit.target)
      const handlePosition = toVec3(handle.position)

      const cameraPatch = {
        camera: { mode: 'free' as const, position, target: orbitTarget, fov: camera.fov },
      }

      switch (target) {
        case 'lasers':
          return { ...cameraPatch, lasers: { origin: handlePosition } }
        case 'lightning':
          return { ...cameraPatch, lightning: { origin: handlePosition } }
        case 'bursts':
          return { ...cameraPatch, bursts: { origin: handlePosition } }
        case 'performer':
          return { ...cameraPatch, performer: { x: handlePosition.x, z: handlePosition.z } }
      }
    },

    dispose: () => {
      gizmo.detach()
      gizmo.dispose()
      scene.remove(gizmoHelper)
      scene.remove(handle)
      orbit.dispose()
    },
  }
}
