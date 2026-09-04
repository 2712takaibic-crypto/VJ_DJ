const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('harness', {
  log: (message) => ipcRenderer.send('harness:log', message),
  report: (payload) => ipcRenderer.send('harness:report', payload),
})
