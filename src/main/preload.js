'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Unwrap { ok, data, error } envelopes into resolved values / thrown errors. */
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (res && res.ok) return res.data;
  throw new Error((res && res.error) || 'Unknown error');
}

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: () => call('settings:get'),
    update: (patch) => call('settings:update', patch),
  },
  recordings: {
    list: () => call('recordings:list'),
    get: (id) => call('recordings:get', id),
    delete: (id) => call('recordings:delete', id),
    retry: (id) => call('recordings:retry', id),
    setDuration: (id, durationSec) => call('recordings:setDuration', { id, durationSec }),
    saveWav: (buffer, durationSec) => call('recordings:saveWav', { buffer, durationSec }),
    import: (durationSec) => call('recordings:import', { durationSec }),
    importPath: (filePath, durationSec) => call('recordings:importPath', { filePath, durationSec }),
    onProgress: (handler) => {
      const listener = (_e, rec) => handler(rec);
      ipcRenderer.on('recordings:progress', listener);
      return () => ipcRenderer.removeListener('recordings:progress', listener);
    },
  },
  files: {
    read: (filePath) => call('files:read', filePath),
    /** Resolve the absolute path of a File object dropped onto the window. */
    pathFor: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch (_) {
        return file && file.path ? file.path : null;
      }
    },
  },
  transcript: {
    copy: (text) => call('transcript:copy', text),
    export: (id) => call('transcript:export', { id }),
  },
  backend: {
    testConnection: (baseUrl) => call('api:testConnection', baseUrl),
  },
  app: {
    info: () => call('app:info'),
    requestMic: () => call('app:requestMic'),
    openRecordingsFolder: () => call('app:openRecordingsFolder'),
    showInFolder: (filePath) => call('app:showInFolder', filePath),
  },
});
