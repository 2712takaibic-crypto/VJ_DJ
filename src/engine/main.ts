import type { ControlToEngine, EngineToControl } from '@shared/renderer/realtime'
import { connectRealtimePort } from '@shared/renderer/connect'
import '@shared/renderer/globals'
import { createStageRenderer } from './stage/renderer'
import { runExport } from './show/export'
import { createShow, SHOT_COUNT } from './show/show'
import { installController } from './control'
import { createPreviewPublisher } from './preview'

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

/**
 * Control Window からのメッセージを処理する。
 *
 * ハンドラは起動の各段階で差し替わる。show の生成前に届いた
 * パラメータ変更を捨てないよう、hello だけは常に応答する。
 */
type EngineHandlers = {
  onParams?: (message: Extract<ControlToEngine, { t: 'params' }>) => void
  onTransport?: (message: Extract<ControlToEngine, { t: 'transport' }>) => void
  onSeek?: (message: Extract<ControlToEngine, { t: 'seek' }>) => void
  onPreviewAck?: (message: Extract<ControlToEngine, { t: 'previewAck' }>) => void
  onPreviewConfig?: (message: Extract<ControlToEngine, { t: 'previewConfig' }>) => void
  onSetVideo?: (message: Extract<ControlToEngine, { t: 'setVideo' }>) => void
  onSetAudio?: (message: Extract<ControlToEngine, { t: 'setAudio' }>) => void
}

const handlers: EngineHandlers = {}

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
    case 'params':
      handlers.onParams?.(message)
      return
    case 'transport':
      handlers.onTransport?.(message)
      return
    case 'seek':
      handlers.onSeek?.(message)
      return
    case 'previewAck':
      handlers.onPreviewAck?.(message)
      return
    case 'previewConfig':
      handlers.onPreviewConfig?.(message)
      return
    case 'setVideo':
      handlers.onSetVideo?.(message)
      return
    case 'setAudio':
      handlers.onSetAudio?.(message)
      return
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

  // --- Control Window との連携 ---
  const preview = createPreviewPublisher(port)
  handlers.onParams = (message) => {
    show.patchParams(message.patch)
  }
  handlers.onTransport = (message) => {
    playing = message.action === 'play'
  }
  handlers.onSeek = (message) => {
    showTime = Math.max(0, Math.min(show.durationSeconds, message.seconds))
  }
  handlers.onPreviewAck = (message) => {
    preview.ack(message.seq)
  }
  handlers.onPreviewConfig = (message) => {
    preview.configure(message.width, message.fps)
  }
  handlers.onSetVideo = (message) => {
    // 差し替えに失敗しても現在の映像を出し続ける
    void show.setVideoSource(message.framesBaseUrl).catch((error: Error) => {
      console.error(`[engine] setVideo failed: ${error.message}`)
    })
  }
  handlers.onSetAudio = (message) => {
    void show
      .setAudioSource(message.analysisUrl)
      .then(() => {
        showTime = 0
      })
      .catch((error: Error) => {
        console.error(`[engine] setAudio failed: ${error.message}`)
      })
  }

  let lastStateSent = 0
  let measuredFps = 0

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

    preview.publish(canvas, now)

    // 状態は 10Hz で足りる。UI の表示を合わせるだけなので
    // 毎フレーム送ると無駄に帯域を使う。
    if (now - lastStateSent >= 100) {
      lastStateSent = now
      const state: EngineToControl = {
        t: 'state',
        params: show.getParams(),
        timeSeconds: showTime,
        playing,
        duration: show.durationSeconds,
        bpm: show.analysis.data.tempo.bpm,
        fps: measuredFps,
      }
      port.postMessage(state)
    }

    frames++
    if (now - lastReport >= 5000) {
      measuredFps = (frames * 1000) / (now - lastReport)
      console.info(`[engine] ${measuredFps.toFixed(1)} fps`)
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
