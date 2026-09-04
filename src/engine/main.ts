import type { ControlToEngine, EngineToControl } from '@shared/protocol/realtime'
import { connectRealtimePort } from '@shared/renderer/connect'
import { createStageRenderer } from './stage/renderer'
import { createStage } from './stage/scene'
import { createPerformer, createVideoElementSource } from './video/performer'

/**
 * Engine Host のエントリポイント。
 *
 * 設計書 §1.1 の設計判断 A により、このレンダラが
 * 音声エンジン・映像エンジン・マスタークロックのすべてを持つ。
 * Control Window は状態を送り、プレビューを受け取るだけの純粋な UI になる。
 */

const OUTPUT_WIDTH = 1920
const OUTPUT_HEIGHT = 1080

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

  // NOTE: 自プロセス同士のチャネルなので現時点では型注釈のみで受けている。
  // 検証を挟むのは P0-16 (zod 導入) 以降。
  port.onmessage = (event: MessageEvent<ControlToEngine>) => {
    handle(port, event.data)
  }
  console.info('[engine] realtime channel connected')

  const stageRenderer = await createStageRenderer({
    canvas,
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
  })
  const stage = createStage()
  stageRenderer.scene.add(stage.root)
  console.info('[engine] stage renderer ready (three WebGPU)')

  // --- 被写体 (グリーンバック → クロマキー → 3D 空間の板) ---
  try {
    const source = await createVideoElementSource('vjdj-media://local/green_back.mp4')
    console.info(
      `[engine] green_back loaded ${source.width}x${source.height} ${source.duration().toFixed(2)}s`,
    )
    const performer = createPerformer(source)
    stage.performerAnchor.add(performer.object)
    await source.play()
    console.info('[engine] performer playing')
  } catch (error) {
    // 被写体が出せなくてもステージは動かす。
    // 素材の問題とレンダリングの問題を切り分けられるようにするため。
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[engine] performer unavailable: ${message}`)
  }

  let frames = 0
  let lastReport = performance.now()

  let renderErrorReported = false
  const tick = (now: number): void => {
    stage.update(now / 1000)
    try {
      stageRenderer.render()
    } catch (error) {
      // 毎フレーム同じ例外を吐くとログが埋まるので 1 回だけ報告する。
      // 黙って握りつぶすと「真っ黒だが原因が分からない」状態になる。
      if (!renderErrorReported) {
        renderErrorReported = true
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
        console.error(`[engine] render failed: ${message}`)
      }
    }

    frames++
    if (now - lastReport >= 5000) {
      const fps = (frames * 1000) / (now - lastReport)
      console.info(`[engine] ${fps.toFixed(1)} fps`)
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
