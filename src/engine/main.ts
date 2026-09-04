import type { ControlToEngine, EngineToControl } from '@shared/protocol/realtime'
import { connectRealtimePort } from '@shared/renderer/connect'
import '@shared/renderer/globals'
import { createStageRenderer } from './stage/renderer'
import { runExport } from './show/export'
import { createShow, SHOT_COUNT } from './show/show'
import { installController } from './control'

/**
 * Engine Host のエントリポイント。
 *
 * 設計書 §1.1 の設計判断 A により、このレンダラが
 * 映像・音・時刻のすべてを持つ。
 *
 * リアルタイム再生と書き出しはどちらも同じ Show を通る。
 * 違いは時刻の与え方だけ (音声クロック / フレーム番号)。
 */

const OUTPUT_WIDTH = 1920
const OUTPUT_HEIGHT = 1080

const ASSETS = {
  analysisUrl: 'vjdj-media://local/hikari.analysis.json',
  framesBaseUrl: 'vjdj-media://local/frames/green_back',
} as const

const canvas = document.getElementById('output')
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('output canvas not found in engine/index.html')
}

const handle = (port: MessagePort, message: ControlToEngine): void => {
  switch (message.t) {
    case 'hello': {
      const ack: EngineToControl = {
        t: 'hello-ack',
        seq: message.seq,
        timeOrigin: performance.timeOrigin,
      }
      port.postMessage(ack)
      return
    }
  }
}

const start = async (): Promise<void> => {
  const port = await connectRealtimePort()
  port.onmessage = (event: MessageEvent<ControlToEngine>) => {
    handle(port, event.data)
  }
  console.info('[engine] realtime channel connected')

  const renderer = await createStageRenderer({
    canvas,
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
  })
  console.info('[engine] stage renderer ready (three WebGPU)')

  const show = await createShow(renderer, ASSETS)
  console.info(
    `[engine] show ready — ${show.durationSeconds.toFixed(2)}s @ ` +
      `${show.analysis.data.tempo.bpm.toFixed(2)}bpm, ${String(show.analysis.data.beats.length)} beats`,
  )

  // --- 書き出しモード ---
  const request = await window.vjdj.exportRequest()
  if (request !== null) {
    console.info('[engine] export mode')
    const result = await runExport(show, renderer, canvas, request, {
      onProgress: (frame, total, elapsed) => {
        const ratio = frame / total
        const eta = ratio > 0 ? elapsed / ratio - elapsed : 0
        console.info(
          `[engine] export ${String(frame)}/${String(total)} ` +
            `(${(ratio * 100).toFixed(1)}%) elapsed=${elapsed.toFixed(0)}s eta=${eta.toFixed(0)}s`,
        )
      },
    })
    if (result.ok) {
      console.info(`[engine] EXPORT OK ${result.outputPath} ${String(result.frames)} frames`)
    } else {
      console.error(`[engine] EXPORT FAIL ${result.error}`)
    }
    return
  }

  // --- リアルタイムプレビュー ---
  // 現状は経過時間で駆動している。音声クロックへの接続は
  // Transport (P0-11) を入れる際に差し替える。
  let frames = 0
  let lastReport = performance.now()
  let renderErrorReported = false

  // 再生位置は「基準時刻からの経過」で持つ。
  // 一時停止やシークは基準をずらすことで表現する。
  let showTime = 0
  let playing = true
  let lastNow = performance.now()

  installController({
    show,
    renderer,
    canvas,
    getTime: () => showTime,
    setTime: (seconds) => {
      showTime = seconds
    },
    isPlaying: () => playing,
    setPlaying: (next) => {
      playing = next
    },
    shotCount: SHOT_COUNT,
  })
  console.info('[engine] controller installed (window.__vjdjControl)')

  const tick = (now: number): void => {
    const delta = (now - lastNow) / 1000
    lastNow = now
    if (playing) showTime = (showTime + delta) % show.durationSeconds
    void show.update(showTime)
    try {
      renderer.render()
    } catch (error) {
      if (!renderErrorReported) {
        renderErrorReported = true
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
        console.error(`[engine] render failed: ${message}`)
      }
    }

    frames++
    if (now - lastReport >= 5000) {
      console.info(`[engine] ${((frames * 1000) / (now - lastReport)).toFixed(1)} fps`)
      frames = 0
      lastReport = now
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

void start().catch((error: Error) => {
  console.error(`[engine] startup failed: ${error.stack ?? error.message}`)
})
