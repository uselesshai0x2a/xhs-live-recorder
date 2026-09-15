import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserApi, BrowserSnapshot } from '../shared/browser'
import type { AppApi, AppSnapshot } from '../shared/app'

const browser: BrowserApi = {
  snapshot: () => ipcRenderer.invoke('browser:snapshot'),
  open: (url) => ipcRenderer.invoke('browser:open', url),
  search: (keyWord) => ipcRenderer.invoke('browser:search', keyWord),
  showQueryPage: (show) => ipcRenderer.invoke('browser:worker', show),
  setBounds: (bounds) => ipcRenderer.invoke('browser:bounds', bounds),
  subscribe: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, state: BrowserSnapshot): void =>
      listener(state)
    ipcRenderer.on('browser:changed', receive)
    return () => ipcRenderer.removeListener('browser:changed', receive)
  }
}
contextBridge.exposeInMainWorld('browser', browser)
const api: AppApi = {
  snapshot: () => ipcRenderer.invoke('app:snapshot'),
  search: (keyword) => ipcRenderer.invoke('app:search', keyword),
  profile: () => ipcRenderer.invoke('app:profile'),
  add: (id) => ipcRenderer.invoke('app:add', id),
  removeTarget: (id) => ipcRenderer.invoke('app:remove', id),
  updateTarget: (id, patch) => ipcRenderer.invoke('app:update', { id, patch }),
  check: (id) => ipcRenderer.invoke('app:check', id),
  record: (id) => ipcRenderer.invoke('app:record', id),
  stop: (id) => ipcRenderer.invoke('app:stop', id),
  resume: (id) => ipcRenderer.invoke('app:resume', id),
  pause: (value) => ipcRenderer.invoke('app:pause', value),
  watch: (id) => ipcRenderer.invoke('app:watch', id),
  page: (page) => ipcRenderer.invoke('app:page', page),
  chooseDirectory: () => ipcRenderer.invoke('app:directory'),
  saveSettings: (settings) => ipcRenderer.invoke('app:settings', settings),
  merge: (id) => ipcRenderer.invoke('app:merge', id),
  files: (id) => ipcRenderer.invoke('app:files', id),
  reveal: (id) => ipcRenderer.invoke('app:reveal', id),
  subscribe: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot): void =>
      listener(snapshot)
    ipcRenderer.on('app:changed', receive)
    return () => ipcRenderer.removeListener('app:changed', receive)
  },
  onWatch: (listener) => {
    ipcRenderer.on('app:watch', listener)
    return () => ipcRenderer.removeListener('app:watch', listener)
  }
}
contextBridge.exposeInMainWorld('recorder', api)
