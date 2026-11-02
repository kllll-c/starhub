/**
 * 预加载脚本：以最小暴露面把主进程能力交给渲染进程。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('starhub', {
  init: () => ipcRenderer.invoke('app:init'),
  listRepos: (params) => ipcRenderer.invoke('repos:list', params),
  listTags: () => ipcRenderer.invoke('tags:list'),
  translateDescriptions: (items) => ipcRenderer.invoke('repos:translate-descriptions', items),
  downloads: (params) => ipcRenderer.invoke('repos:downloads', params),
  detail: (params) => ipcRenderer.invoke('repo:detail', params),
  readme: (params) => ipcRenderer.invoke('repo:readme', params),
  translateReadme: (params) => ipcRenderer.invoke('repo:translate-readme', params),
  translateText: (params) => ipcRenderer.invoke('repo:translate-text', params),
  library: () => ipcRenderer.invoke('library:get'),
  toggle: (params) => ipcRenderer.invoke('library:toggle', params),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  translateStatus: () => ipcRenderer.invoke('translate:status'),
  setTheme: (theme) => ipcRenderer.invoke('window:theme', theme),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  copy: (text) => ipcRenderer.invoke('clipboard:copy', text),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  cacheStats: () => ipcRenderer.invoke('cache:stats'),
});
