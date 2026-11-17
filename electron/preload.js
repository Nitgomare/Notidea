'use strict';
// 页面 ↔ 主进程的桥：窗口按钮与最大化状态
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__shell', {
  platform: process.platform,
  post: (action) => ipcRenderer.send('shell', action),
  pickDir: (current) => ipcRenderer.invoke('pick-dir', current),
  onState: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('shell-state', (_e, state) => cb(state || {}));
  },
});
