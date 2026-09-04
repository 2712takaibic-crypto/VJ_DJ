import type { StageRenderer } from './stage/renderer'
import type { Show } from './show/show'
import type { ShowParams, ShowParamsPatch } from '@shared/protocol/show-params'

/**
 * 外部からショーを操作するための窓口。
 *
 * main プロセスが `executeJavaScript` でここを呼び、
 * さらにその先で HTTP / MCP へ繋がる。
 *
 * **`capture` が最も重要**。
 * AI がプロンプトで VJ を操作するには、結果を見られることが前提になる。
 * 画を見ずにパラメータを触るのは、目をつぶって色を選ぶのと同じ。
 */

export type ControlState = {
  readonly params: ShowParams
  readonly timeSeconds: number
  readonly playing: boolean
  readonly duration: number
  readonly bpm: number
  readonly beatCount: number
  readonly output: { readonly width: number; readonly height: number }
  readonly shotCount: number
}

export type ShowController = {
  getState(): ControlState
  setParams(patch: ShowParamsPatch): ControlState
  seek(seconds: number): void
  setPlaying(playing: boolean): void
  /** 指定時刻を描画して JPEG の data URL を返す */
  capture(seconds: number | null, maxWidth: number): Promise<string>
}

declare global {
  interface Window {
    __vjdjControl?: ShowController
  }
}

export type ControlHost = {
  readonly show: Show
  readonly renderer: StageRenderer
  readonly canvas: HTMLCanvasElement
  getTime(): number
  setTime(seconds: number): void
  isPlaying(): boolean
  setPlaying(playing: boolean): void
  shotCount: number
}

export const installController = (host: ControlHost): ShowController => {
  const buildState = (): ControlState => ({
    params: host.show.getParams(),
    timeSeconds: host.getTime(),
    playing: host.isPlaying(),
    duration: host.show.durationSeconds,
    bpm: host.show.analysis.data.tempo.bpm,
    beatCount: host.show.analysis.data.beats.length,
    output: { width: host.renderer.size.width, height: host.renderer.size.height },
    shotCount: host.shotCount,
  })

  const controller: ShowController = {
    getState: buildState,

    setParams: (patch) => {
      host.show.patchParams(patch)
      return buildState()
    },

    seek: (seconds) => {
      host.setTime(Math.max(0, Math.min(host.show.durationSeconds, seconds)))
    },

    setPlaying: (playing) => {
      host.setPlaying(playing)
    },

    capture: async (seconds, maxWidth) => {
      const t = seconds ?? host.getTime()
      // 映像フレームの読み込みまで待つ。待たないと前のフレームが写る。
      await host.show.update(t, { awaitFrames: true })
      host.renderer.render()

      const bitmap = await createImageBitmap(host.canvas)
      const scale = Math.min(1, maxWidth / bitmap.width)
      const width = Math.round(bitmap.width * scale)
      const height = Math.round(bitmap.height * scale)
      const surface = new OffscreenCanvas(width, height)
      const context = surface.getContext('2d')
      if (context === null) throw new Error('failed to acquire 2d context for capture')
      context.drawImage(bitmap, 0, 0, width, height)
      bitmap.close()

      const blob = await surface.convertToBlob({ type: 'image/jpeg', quality: 0.86 })
      const buffer = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (const byte of buffer) binary += String.fromCharCode(byte)
      return `data:image/jpeg;base64,${btoa(binary)}`
    },
  }

  window.__vjdjControl = controller
  return controller
}
