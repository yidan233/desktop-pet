const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('petAPI', {
  getInit: () => ipcRenderer.invoke('init'),
  setIgnore: (v) => ipcRenderer.send('set-ignore', !!v),
  showMenu: (info) => ipcRenderer.send('show-menu', info),
  savePrefs: (p) => ipcRenderer.send('save-prefs', p),
  onAction: (cb) => ipcRenderer.on('action', (_e, a) => cb(a)),
  onPets: (cb) => ipcRenderer.on('pets', (_e, a) => cb(a))
});
