import { contextBridge, ipcRenderer } from 'electron'
import type { VjdjApi } from '@shared/protocol/api'
import { PORT_ENVELOPE } from '@shared/protocol/realtime'
import { isWindowRole, ROLE_ARG_PREFIX, type WindowRole } from '@shared/protocol/window'

/**
 * レンダラへ公開する API。
 *
 * レンダラは sandbox 内で動き、ファイル I/O も子プロセス起動も
 * ここを通してしか行えない (設計書 §6.1)。
 */

const resolveRole = (): WindowRole => {
  const arg = process.argv.find((a) => a.startsWith(ROLE_ARG_PREFIX))
  const value = arg?.slice(ROLE_ARG_PREFIX.length) ?? ''
  if (!isWindowRole(value)) {
    throw new Error(`preload launched without a valid ${ROLE_ARG_PREFIX} argument (got "${value}")`)
  }
  return value
}

const role = resolveRole()

/**
 * MessagePort は contextBridge を通せない。
 * また contextBridge は値をディープクローンするため、仮に通せたとしても
 * ImageBitmap のゼロコピー転送 (設計書 §2.2.10) が成立しなくなる。
 *
 * したがってポートは window.postMessage で主ワールドへ「転送」する。
 * 以降 Control ⇄ Engine のやり取りは主ワールド同士が直接行い、
 * preload も main も一切介在しない。
 */
const relayToMainWorld = (port: MessagePort): void => {
  window.postMessage({ [PORT_ENVELOPE]: true }, '*', [port])
}

let bufferedPort: MessagePort | null = null
let mainWorldReady = false

ipcRenderer.on('realtime:port', (event) => {
  const port = event.ports[0]
  if (port === undefined) return
  if (mainWorldReady) {
    relayToMainWorld(port)
  } else {
    // 主ワールドのリスナ登録前に届いた場合に備えて保持する
    bufferedPort = port
  }
})

const api: VjdjApi = {
  role,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  exportBegin: (config) => ipcRenderer.invoke('export:begin', config),
  // フレームは JPEG に圧縮済み。生 RGBA を送ると 90 秒で 22GB になる。
  exportFrame: (jpeg) => ipcRenderer.invoke('export:frame', jpeg),
  exportFinish: () => ipcRenderer.invoke('export:finish'),
  exportRequest: () => ipcRenderer.invoke('export:request'),
  ready: () => {
    mainWorldReady = true
    if (bufferedPort !== null) {
      relayToMainWorld(bufferedPort)
      bufferedPort = null
    }
    // main へ「このレンダラは受け取れる状態になった」と伝える。
    // main は両レンダラが揃ってから初めてポートを配る。
    ipcRenderer.send('window:ready', role)
  },
}

contextBridge.exposeInMainWorld('vjdj', api)
