// PoC 計測用 preload。製品と同じ sandbox / contextIsolation 条件で測るために必要。
// ポートは contextBridge を通せないため window.postMessage で主ワールドへ転送する
// (製品側 src/preload/index.ts と同じ方式)。
const { contextBridge, ipcRenderer } = require('electron')

const ENVELOPE = '__vjdj:realtime-port'

let buffered = null
let mainWorldReady = false

const relay = (port) => {
  window.postMessage({ [ENVELOPE]: true }, '*', [port])
}

ipcRenderer.on('realtime:port', (event) => {
  const port = event.ports[0]
  if (!port) return
  if (mainWorldReady) relay(port)
  else buffered = port
})

contextBridge.exposeInMainWorld('poc', {
  envelope: ENVELOPE,
  role: process.argv.find((a) => a.startsWith('--poc-role='))?.slice('--poc-role='.length) ?? '',
  ready: () => {
    mainWorldReady = true
    if (buffered) {
      relay(buffered)
      buffered = null
    }
    ipcRenderer.send('poc:ready')
  },
  log: (m) => ipcRenderer.send('poc:log', m),
  report: (payload) => ipcRenderer.send('poc:report', payload),
  config: () => ipcRenderer.invoke('poc:config'),
})
