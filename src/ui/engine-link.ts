import type { ShowParams, ShowParamsPatch } from '@shared/protocol/show-params'
import type { ControlToEngine, DjStatePayload, EngineToControl } from '@shared/renderer/realtime'
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
  setVideoSource(framesBaseUrl: string): void
  setAudioSource(analysisUrl: string): void

  // --- DJ ---
  djLoadDeck(deck: 'A' | 'B', url: string, name: string, bpm: number | null): void
  djDeck(deck: 'A' | 'B', action: 'play' | 'pause'): void
  djSeek(deck: 'A' | 'B', seconds: number): void
  djRate(deck: 'A' | 'B', rate: number): void
  djGain(deck: 'A' | 'B', gain: number): void
  djEq(deck: 'A' | 'B', band: 'low' | 'mid' | 'high', db: number): void
  djCrossfader(value: number): void
  djCurve(curve: 'smooth' | 'sharp'): void
  djMaster(value: number): void
  djLoadPad(index: number, url: string, name: string): void
  djTriggerPad(index: number): void
  onDjState(handler: (state: DjStatePayload) => void): () => void
  /** 状態が届くたびに呼ばれる (約 10Hz) */
  onState(handler: (state: EngineState) => void): () => void
  /** プレビュー画像が届くたびに呼ばれる。使い終えたら close すること */
  onPreview(handler: (bitmap: ImageBitmap) => void): () => void
}

export const connectEngine = async (): Promise<EngineLink> => {
  const port = await connectRealtimePort()

  const stateHandlers = new Set<(state: EngineState) => void>()
  const previewHandlers = new Set<(bitmap: ImageBitmap) => void>()
  const djHandlers = new Set<(state: DjStatePayload) => void>()

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
      case 'djState': {
        for (const handler of djHandlers) handler(message.state)
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
    setVideoSource: (framesBaseUrl) => {
      send({ t: 'setVideo', framesBaseUrl })
    },
    setAudioSource: (analysisUrl) => {
      send({ t: 'setAudio', analysisUrl })
    },
    djLoadDeck: (deck, url, name, bpm) => {
      send({ t: 'djLoadDeck', deck, url, name, bpm })
    },
    djDeck: (deck, action) => {
      send({ t: 'djDeck', deck, action })
    },
    djSeek: (deck, seconds) => {
      send({ t: 'djSeek', deck, seconds })
    },
    djRate: (deck, rate) => {
      send({ t: 'djRate', deck, rate })
    },
    djGain: (deck, gain) => {
      send({ t: 'djGain', deck, gain })
    },
    djEq: (deck, band, db) => {
      send({ t: 'djEq', deck, band, db })
    },
    djCrossfader: (value) => {
      send({ t: 'djCrossfader', value })
    },
    djCurve: (curve) => {
      send({ t: 'djCurve', curve })
    },
    djMaster: (value) => {
      send({ t: 'djMaster', value })
    },
    djLoadPad: (index, url, name) => {
      send({ t: 'djLoadPad', index, url, name })
    },
    djTriggerPad: (index) => {
      send({ t: 'djTriggerPad', index })
    },
    onDjState: (handler) => {
      djHandlers.add(handler)
      return () => djHandlers.delete(handler)
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
