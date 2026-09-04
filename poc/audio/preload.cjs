const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('poc', {
  log: (m) => ipcRenderer.send('poc:log', m),
  report: (payload) => ipcRenderer.send('poc:report', payload),
  config: () => ipcRenderer.invoke('poc:config'),
})
