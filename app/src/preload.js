"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
contextBridge.exposeInMainWorld('managerVideoLogAPI', {
  list: input => ipcRenderer.invoke('video-log:list', input),
  status: () => ipcRenderer.invoke('video-log:status'),
  history: name => ipcRenderer.invoke('video-log:history', name),
  set: input => ipcRenderer.invoke('video-log:set', input),
  clear: () => ipcRenderer.invoke('video-log:clear'),
  export: filter => ipcRenderer.invoke('video-log:export', filter),
  onChanged: callback => ipcRenderer.on('video-log:changed', () => callback()),
});
contextBridge.exposeInMainWorld('managerHDAPI', {
  list:()=>ipcRenderer.invoke('hd:list'),
  scan:accountId=>ipcRenderer.invoke('hd:scan',accountId),
  download:input=>ipcRenderer.invoke('hd:download',input),
  cancel:id=>ipcRenderer.invoke('hd:cancel',id),
  reveal:id=>ipcRenderer.invoke('hd:reveal',id),
  onChanged:callback=>ipcRenderer.on('hd:changed',()=>callback()),
});

contextBridge.exposeInMainWorld("managerAPI", {
  app: {
    relaunch: () => ipcRenderer.invoke("app:relaunch"),
  },
  runtime: {
    webviewPreloadUrl: pathToFileURL(path.join(__dirname, "webview-preload.js")).toString(),
    noWatermarkResolver: () => ipcRenderer.invoke("runtime:no-watermark-resolver"),
    capabilities: () => ipcRenderer.invoke("runtime:capabilities"),
    debugger: {
      attach: (input) => ipcRenderer.invoke("runtime:debugger-attach", input),
      send: (input) => ipcRenderer.invoke("runtime:debugger-send", input),
      poll: (input) => ipcRenderer.invoke("runtime:debugger-poll", input),
      detach: (input) => ipcRenderer.invoke("runtime:debugger-detach", input),
    },
    report: (input) => ipcRenderer.invoke("runtime:report", input),
    onWebviewGone: (callback) => ipcRenderer.on("webview:gone", (_event, payload) => callback(payload)),
  },
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    maximize: () => ipcRenderer.send("window:maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  },
  clipboard: {
    write: (value) => ipcRenderer.invoke("clipboard:write", value),
  },
  license: {
    status: () => ipcRenderer.invoke("license:status"),
    activate: (value) => ipcRenderer.invoke("license:activate", value),
    open: () => ipcRenderer.invoke("license:open"),
    onMessage: (callback) => ipcRenderer.on("license:message", (_event, payload) => callback(payload)),
  },
  platforms: {
    list: () => ipcRenderer.invoke("platforms:list"),
  },
  accounts: {
    list: () => ipcRenderer.invoke("accounts:list"),
    add: (input) => ipcRenderer.invoke("accounts:add", input),
    update: (accountId, input) => ipcRenderer.invoke("accounts:update", accountId, input),
    delete: (accountId, input = {}) => ipcRenderer.invoke("accounts:delete", accountId, input),
    export: (input) => ipcRenderer.invoke("accounts:export", input),
    import: () => ipcRenderer.invoke("accounts:import-compatible"),
    pendingStorage: (input) => ipcRenderer.invoke("accounts:pending-storage", input),
    storageRestored: (input) => ipcRenderer.invoke("accounts:storage-restored", input),
  },
  resources: {
    list: () => ipcRenderer.invoke("resources:list"),
    capture: (accountId, input) => ipcRenderer.invoke("resources:capture", accountId, input),
    clear: () => ipcRenderer.invoke("resources:clear"),
    onUpdated: (callback) => ipcRenderer.on("resources:updated", (_event, payload) => callback(payload)),
  },
  video: {
    choose: () => ipcRenderer.invoke("video:choose"),
    removeWatermark: (input) => ipcRenderer.invoke("video:remove-watermark", input),
    openOutput: (input) => ipcRenderer.invoke("video:open-output", input),
    onProgress: (callback) => ipcRenderer.on("video:progress", (_event, payload) => callback(payload)),
  },
  downloads: {
    path: () => ipcRenderer.invoke("downloads:path"),
    choosePath: () => ipcRenderer.invoke("downloads:choose-path"),
    openPath: () => ipcRenderer.invoke("downloads:open-path"),
    list: () => ipcRenderer.invoke("downloads:list"),
    openFile: (input) => ipcRenderer.invoke("downloads:open-file", input),
    reveal: (input) => ipcRenderer.invoke("downloads:reveal", input),
    delete: (input) => ipcRenderer.invoke("downloads:delete", input),
    resource: (input) => ipcRenderer.invoke("downloads:resource", input),
    onFinished: (callback) => ipcRenderer.on("download:finished", (_event, payload) => callback(payload)),
  },
});

contextBridge.exposeInMainWorld("managerProxyAPI", {
  list: () => ipcRenderer.invoke("account-proxy:list"),
  get: (accountId) => ipcRenderer.invoke("account-proxy:get", accountId),
  save: (input) => ipcRenderer.invoke("account-proxy:save", input),
  disable: (accountId) => ipcRenderer.invoke("account-proxy:disable", accountId),
  test: (input) => ipcRenderer.invoke("account-proxy:test", input),
  onChanged: (callback) => ipcRenderer.on("account-proxy:changed", (_event, payload) => callback(payload)),
});

contextBridge.exposeInMainWorld("managerProxyPoolAPI", {
  get: () => ipcRenderer.invoke("account-proxy-pool:get"),
  sync: (input) => ipcRenderer.invoke("account-proxy-pool:sync", input),
  save: (input) => ipcRenderer.invoke("account-proxy-pool:save", input),
  test: () => ipcRenderer.invoke("account-proxy-pool:test"),
  apply: () => ipcRenderer.invoke("account-proxy-pool:apply"),
  stop: () => ipcRenderer.invoke("account-proxy-pool:stop"),
});
