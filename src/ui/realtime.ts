import type { HandshakeStatus } from '@shared/protocol/handshake'
import type { ControlToEngine, EngineToControl } from '@shared/renderer/realtime'
import { connectRealtimePort } from '@shared/renderer/connect'
import '@shared/renderer/globals'

const HELLO_TIMEOUT_MS = 5_000

/** ハンドシェイクの応答だけを取り出した型 */
type HelloAck = Extract<EngineToControl, { t: 'hello-ack' }>

const awaitAck = (port: MessagePort, seq: number): Promise<HelloAck> =>
  new Promise<HelloAck>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`hello-ack did not arrive within ${String(HELLO_TIMEOUT_MS)}ms`))
    }, HELLO_TIMEOUT_MS)

    port.onmessage = (event: MessageEvent<EngineToControl>) => {
      const message = event.data
      if (message.t !== 'hello-ack' || message.seq !== seq) return
      clearTimeout(timer)
      resolve(message)
    }

    const hello: ControlToEngine = { t: 'hello', seq }
    port.postMessage(hello)
  })

/**
 * Engine Host との RealtimeChannel を確立し、往復まで確認する。
 * 結果は `window.__vjdjHandshake` にも公開する (設計: handshake.ts)。
 */
export const startRealtime = async (): Promise<HandshakeStatus> => {
  let status: HandshakeStatus
  try {
    const port = await connectRealtimePort()
    const sentAt = performance.now()
    const ack = await awaitAck(port, 1)
    status = {
      state: 'ok',
      rttMs: performance.now() - sentAt,
      peerTimeOrigin: ack.timeOrigin,
    }
    console.info(`[control] realtime channel ok — rtt=${status.rttMs.toFixed(2)}ms`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    status = { state: 'failed', error: message }
    console.error(`[control] realtime channel failed: ${message}`)
  }
  window.__vjdjHandshake = status
  return status
}
