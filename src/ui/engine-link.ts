import type { ShowParams, ShowParamsPatch } from '@shared/protocol/show-params'
import type { ControlToEngine, EngineToControl } from '@shared/renderer/realtime'
import { connectRealtimePort } from '@shared/renderer/connect'
import '@shared/renderer/globals'

/**
 * Engine Host との接続。
 *
 * 設計書 §1.1 設計判断 B のとおり、パラメータの操作は
 * この RealtimeChannel を通す。main プロセスは経由しない。
 * ノブを動かしている間の値は揮発でよく、Undo の対象にもならない。
 */

export type EngineState = {
  readonly params: ShowParams
  readonly timeSeconds: number
  readonly playing: boolean
  readonly duration: number
  readonly bpm: number
  readonly fps: number
}

export type EngineLink = {
  setParams(patch: ShowParamsPatch): void
  setPlaying(playing: boolean): void
  seek(seconds: number): void
  configurePreview(width: number, fps: number): void
  /** 状態が届くたびに呼ばれる (約 10Hz) */
  onState(handler: (state: EngineState) => void): () => void
  /** プレビュー画像が届くたびに呼ばれる。使い終えたら close すること */
  onPreview(handler: (bitmap: ImageBitmap) => void): () => void
}

export const connectEngine = async (): Promise<EngineLink> => {
  const port = await connectRealtimePort()

  const stateHandlers = new Set<(state: EngineState) => void>()
  const previewHandlers = new Set<(bitmap: ImageBitmap) => void>()

  port.onmessage = (event: MessageEvent<EngineToControl>) => {
    const message = event.data
    switch (message.t) {
      case 'state': {
        const state: EngineState = {
          params: message.params,
          timeSeconds: message.timeSeconds,
          playing: message.playing,
          duration: message.duration,
          bpm: message.bpm,
          fps: message.fps,
        }
        for (const handler of stateHandlers) handler(state)
        return
      }
      case 'preview': {
        // 受け取ったことを必ず返す。返さないと背圧で発行が止まる。
        const ack: ControlToEngine = { t: 'previewAck', seq: message.seq }
        port.postMessage(ack)
        for (const handler of previewHandlers) handler(message.bitmap)
        // 購読者がいなければここで閉じる。放置するとリークする。
        if (previewHandlers.size === 0) message.bitmap.close()
        return
      }
      default:
        return
    }
  }

  const send = (message: ControlToEngine): void => {
    port.postMessage(message)
  }

  // ハンドシェイク。Engine 側が応答できる状態かを確かめる。
  send({ t: 'hello', seq: 1 })

  return {
    setParams: (patch) => {
      send({ t: 'params', patch })
    },
    setPlaying: (playing) => {
      send({ t: 'transport', action: playing ? 'play' : 'pause' })
    },
    seek: (seconds) => {
      send({ t: 'seek', seconds })
    },
    configurePreview: (width, fps) => {
      send({ t: 'previewConfig', width, fps })
    },
    onState: (handler) => {
      stateHandlers.add(handler)
      return () => stateHandlers.delete(handler)
    },
    onPreview: (handler) => {
      previewHandlers.add(handler)
      return () => previewHandlers.delete(handler)
    },
  }
}
