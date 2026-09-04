import { isPortEnvelope } from '@shared/protocol/realtime'
import '@shared/renderer/globals'

/**
 * RealtimeChannel のポートを受け取る。両レンダラの主ワールドから呼ぶ。
 *
 * 順序が要点。
 *   1. message リスナを登録する
 *   2. その後で `window.vjdj.ready()` を呼び、ハンドシェイクを開始する
 *
 * 逆順にするとポートを取りこぼす。Electron ではこのレースが実際に報告されている
 * (ready-to-show でポートを送ると受信側のリスナ登録前に届く事例)。
 * 呼び出し側が順序を間違えられないよう、この関数が両方を行う。
 */
export const connectRealtimePort = (timeoutMs = 10_000): Promise<MessagePort> =>
  new Promise<MessagePort>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
    }

    const onMessage = (event: MessageEvent<object | null>): void => {
      // preload からの window.postMessage 以外は無視する
      if (event.source !== window) return
      if (!isPortEnvelope(event.data)) return
      const port = event.ports[0]
      if (port === undefined) {
        cleanup()
        reject(new Error('port envelope arrived without a MessagePort'))
        return
      }
      cleanup()
      port.start()
      resolve(port)
    }

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`realtime port was not delivered within ${String(timeoutMs)}ms`))
    }, timeoutMs)

    window.addEventListener('message', onMessage)
    window.vjdj.ready()
  })
