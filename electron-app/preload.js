const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hekla', {
  // Navigation
  navigate: (page) => ipcRenderer.invoke('navigate', page),

  // Store
  getConfig: (key) => ipcRenderer.invoke('store:get', key),
  setConfig: (key, value) => ipcRenderer.invoke('store:set', key, value),

  // OAuth
  startMicrosoftAuth: () => ipcRenderer.invoke('auth:start-microsoft'),
  getAuthStatus: () => ipcRenderer.invoke('auth:get-status'),
  logout: () => ipcRenderer.invoke('auth:logout'),

  // API
  checkHealth: () => ipcRenderer.invoke('api:health'),
  getModels: () => ipcRenderer.invoke('api:models'),
  getServices: () => ipcRenderer.invoke('api:services'),
  sendTask: (message) => ipcRenderer.invoke('api:task', message),

  // Setup
  completeSetup: (userId) => ipcRenderer.invoke('setup:complete', userId),
  runSmokeTest: () => ipcRenderer.invoke('setup:smoke-test'),
});
