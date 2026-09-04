// PoC 計測用の preload。
// 本番と同じ sandbox: true / contextIsolation: true の条件下で測るために必要。
// (nodeIntegration を有効にして測ると、計測対象の環境が変わってしまう)
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('poc', {
  report: (payload) => ipcRenderer.send('poc:report', payload),
  log: (message) => ipcRenderer.send('poc:log', message),
  config: () => ipcRenderer.invoke('poc:config'),
})
