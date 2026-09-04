import * as THREE from 'three/webgpu'
import type { StageRenderer } from '@engine/stage/renderer'
import { createStage, type Stage } from '@engine/stage/scene'
import { createPerformer, type Performer } from '@engine/video/performer'
import { createFrameSequenceSource, type FrameSequenceSource } from '@engine/video/frame-sequence'
import { loadAnalysis, type Analysis } from './analysis'
import {
  applyParamsPatch,
  DEFAULT_SHOW_PARAMS,
  type ShowParams,
  type ShowParamsPatch,
} from './params'

/**
 * MV 本体。
 *
 * **すべてが `timeSeconds` の関数**であることがこの設計の要。
 * リアルタイム再生では音声クロックから、書き出しでは
 * `frameIndex / fps` から時刻を与える。どちらも同じコードを通るので、
 * 「プレビューで見た画がそのまま書き出される」ことが保証される。
 *
 * 内部に累積状態を持たせてはならない。持たせた瞬間に、
 * シークしたときと書き出し直したときで結果が変わる。
 */

export type Show = {
  readonly analysis: Analysis
  readonly stage: Stage
  readonly performer: Performer
  readonly durationSeconds: number
  /**
   * 指定時刻の状態にする。
   * 書き出しでは必ず await すること (映像フレームの読み込みを待つ必要がある)。
   */
  update(timeSeconds: number, options?: { readonly awaitFrames?: boolean }): Promise<void>
  /** 現在の調整パラメータ */
  getParams(): ShowParams
  /** 指定された値だけを差し替える */
  patchParams(patch: ShowParamsPatch): ShowParams
  dispose(): void
}

export type ShowAssets = {
  readonly analysisUrl: string
  readonly framesBaseUrl: string
}

/** カメラのショット。小節番号から決定的に選ぶ */
type Shot = {
  readonly position: THREE.Vector3
  readonly target: THREE.Vector3
  readonly fov: number
  /** 時間とともに動かす量 */
  readonly drift: (t: number) => THREE.Vector3
}

const SHOTS: readonly Shot[] = [
  {
    // 正面ミディアム
    position: new THREE.Vector3(0, 2.5, 6.4),
    target: new THREE.Vector3(0, 2.3, 0),
    fov: 44,
    drift: (t) => new THREE.Vector3(Math.sin(t * 0.18) * 0.7, Math.sin(t * 0.11) * 0.2, 0),
  },
  {
    // 下手からの寄り
    position: new THREE.Vector3(-3.9, 2.7, 5.6),
    target: new THREE.Vector3(0.1, 2.4, -1),
    fov: 42,
    drift: (t) => new THREE.Vector3(Math.sin(t * 0.22) * 0.5, 0.15 + Math.sin(t * 0.3) * 0.15, 0),
  },
  {
    // 上手からのロー
    position: new THREE.Vector3(4.2, 1.6, 5.2),
    target: new THREE.Vector3(-0.1, 2.5, -1),
    fov: 44,
    drift: (t) => new THREE.Vector3(-Math.sin(t * 0.19) * 0.6, Math.sin(t * 0.26) * 0.2, 0),
  },
  {
    // 引きのワイド。ステージ全体を見せる
    position: new THREE.Vector3(0, 3.4, 9.2),
    target: new THREE.Vector3(0, 2.6, -1.5),
    fov: 48,
    drift: (t) => new THREE.Vector3(Math.sin(t * 0.13) * 1.6, Math.cos(t * 0.09) * 0.4, 0),
  },
]

export const SHOT_COUNT = SHOTS.length

/** 小節番号からショットを決める。純関数なので再現する */
const shotForBar = (bar: number, barsPerShot: number): Shot => {
  const index = Math.floor(Math.max(0, bar) / Math.max(1, barsPerShot)) % SHOTS.length
  return SHOTS[index] ?? SHOTS[0]!
}

export const createShow = async (renderer: StageRenderer, assets: ShowAssets): Promise<Show> => {
  const analysis = await loadAnalysis(assets.analysisUrl)
  const frames: FrameSequenceSource = await createFrameSequenceSource(assets.framesBaseUrl)

  const stage = createStage()
  renderer.scene.add(stage.root)

  const performer = createPerformer(frames.texture, frames.width, frames.height)
  stage.performerAnchor.add(performer.object)

  const camera = renderer.camera
  let params: ShowParams = DEFAULT_SHOW_PARAMS

  const applyStaticParams = (next: ShowParams): void => {
    performer.keyMaterial.setParams(next.chroma)
    performer.keyMaterial.setMatteView(next.chroma.matteView)
    performer.setHeight(next.performer.heightMeters)
  }
  applyStaticParams(params)

  return {
    analysis,
    stage,
    performer,
    durationSeconds: analysis.data.durationSeconds,

    update: async (t, options = {}) => {
      // --- 映像フレーム ---
      // 曲より素材が短いのでループさせる
      const framePromise = frames.setTime(t, true)
      if (options.awaitFrames === true) await framePromise
      else void framePromise.catch(() => undefined)
      frames.prefetch(t, 6, true)

      // --- 音の状態 (すべて時刻の純関数) ---
      const pulse = analysis.beatPulseAt(t, 1)
      const bar = analysis.barAt(t)
      const low = analysis.envelopeAt('low', t)
      const mid = analysis.envelopeAt('mid', t)
      const high = analysis.envelopeAt('high', t)
      const rms = analysis.envelopeAt('rms', t)
      const onset = analysis.envelopeAt('onset', t)

      // --- ステージ ---
      stage.update(
        t,
        { pulse, low, mid, high, rms, onset },
        { lasers: params.lasers, wall: params.wall, particles: params.particles },
      )

      // --- 被写体 ---
      // 低音に合わせてわずかに上下させると、板が生きて見える
      performer.object.position.set(
        params.performer.x,
        low * params.performer.bounce,
        params.performer.z,
      )
      performer.object.scale.setScalar(1 + pulse * 0.015)

      // --- カメラ ---
      const shot =
        params.camera.mode === 'manual'
          ? (SHOTS[params.camera.shotIndex % SHOTS.length] ?? SHOTS[0]!)
          : shotForBar(bar, params.camera.barsPerShot)
      const drift = shot.drift(t)
      camera.fov = shot.fov
      camera.position.set(
        shot.position.x + drift.x,
        shot.position.y + drift.y,
        shot.position.z + drift.z,
      )
      camera.lookAt(shot.target)
      camera.updateProjectionMatrix()

      // --- ポストプロセス ---
      // サビで画が持ち上がるよう、全体の音量にブルームを追従させる
      const response = params.bloom.audioResponse
      renderer.setBloom(
        params.bloom.strength + (rms * 0.85 + onset * 0.35) * response,
        params.bloom.radius + high * 0.25 * response,
        params.bloom.threshold - rms * 0.15 * response,
      )
    },

    getParams: () => params,

    patchParams: (patch) => {
      params = applyParamsPatch(params, patch)
      applyStaticParams(params)
      return params
    },

    dispose: () => {
      performer.dispose()
      frames.dispose()
      stage.dispose()
    },
  }
}
