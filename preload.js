// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hugston', {
  // File selection operations
  chooseModelFolder: () => ipcRenderer.invoke('choose-model-folder'),
  chooseModelFile: () => ipcRenderer.invoke('choose-model-file'),
  setModelFolder: (folder) => ipcRenderer.invoke('set-model-folder', folder),

  // Model management
  getModels: () => ipcRenderer.invoke('get-models'),
  loadModel: (opts) => ipcRenderer.invoke('load-model', opts),
  unloadModel: () => ipcRenderer.invoke('unload-model'),

  // Inference operations
  sendPrompt: (prompt) => ipcRenderer.invoke('send-prompt', prompt),
  cancelInference: () => ipcRenderer.invoke('cancel-inference'),

  // Event listeners
  onLog: (fn) => {
    ipcRenderer.on('server-log', (_e, msg) => fn(msg));
  },
  onLoadingStart: (fn) => {
    ipcRenderer.on('model-loading-start', fn);
  },
  onLoadingDone: (fn) => {
    ipcRenderer.on('model-loading-done', fn);
  },
  onModelUnloaded: (fn) => {
    ipcRenderer.on('model-unloaded', fn);
  },
  onModelChunk: (fn) => {
    ipcRenderer.on('model-chunk', (_e, chunk) => fn(chunk));
  },
  onModelReply: (fn) => {
    ipcRenderer.on('model-reply', fn);
  },
  onInferenceStopped: (fn) => {
    ipcRenderer.on('inference-stopped', fn);
  }
});
