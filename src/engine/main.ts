import type { ControlToEngine, EngineToControl } from '@shared/protocol/realtime'
import { connectRealtimePort } from '@shared/renderer/connect'

/**
 * Engine Host のエントリポイント。
 *
 * 設計書 §1.1 の設計判断 A により、このレンダラが
 * 音声エンジン・映像エンジン・マスタークロックのすべてを持つ。
 * Control Window は状態を送り、プレビューを受け取るだけの純粋な UI になる。
 *
 * P0-3 時点では RealtimeChannel の疎通まで。以降で追加する:
 *   P0-11 Transport / ClockSource
 *   P1-1  GpuContext
 */

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

  // NOTE: ここは自プロセス同士のチャネルなので P0-3 時点では型注釈のみで受けている。
  // P0-16 で zod による検証を挟み、プロトコル不整合を実行時に検出できるようにする。
  port.onmessage = (event: MessageEvent<ControlToEngine>) => {
    handle(port, event.data)
  }

  console.info('[engine] realtime channel connected')
}

void start().catch((error: Error) => {
  console.error(`[engine] failed to connect realtime channel: ${error.message}`)
})
