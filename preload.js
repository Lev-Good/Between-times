'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s, approvalCode) => ipcRenderer.invoke('settings:save', s, approvalCode),
  getStatus: () => ipcRenderer.invoke('status:get'),
  lockNow: () => ipcRenderer.invoke('lock:now'),
  unlockNow: (pin, approvalCode) => ipcRenderer.invoke('unlock:now', pin, approvalCode),
  requestUnlockApproval: (purpose) => ipcRenderer.invoke('accountability:request-approval', purpose),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  setBlockBg: (bg) => ipcRenderer.invoke('block:set-bg', bg),

  setPin: (pin, oldPin) => ipcRenderer.invoke('pin:set', pin, oldPin),
  clearPin: (oldPin) => ipcRenderer.invoke('pin:clear', oldPin),
  verifyPin: (pin) => ipcRenderer.invoke('pin:verify', pin),

  getSession: () => ipcRenderer.invoke('session:get'),
  unlockSession: (pin) => ipcRenderer.invoke('session:unlock', pin),
  lockSession: () => ipcRenderer.invoke('session:lock'),

  sendRecovery: () => ipcRenderer.invoke('recovery:send'),
  completeRecovery: (code, newPin) => ipcRenderer.invoke('recovery:complete', code, newPin),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),

  getActivity: (limit) => ipcRenderer.invoke('activity:get', limit),
  getSecurity: () => ipcRenderer.invoke('security:get'),
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  importBackup: () => ipcRenderer.invoke('backup:import'),

  pickAllowedApp: () => ipcRenderer.invoke('allowed-apps:pick'),
  detectAllowedApps: () => ipcRenderer.invoke('allowed-apps:detect'),
  inspectAllowedAppPath: (p) => ipcRenderer.invoke('allowed-apps:inspect-path', p),
  launchAllowedApp: (app) => ipcRenderer.invoke('allowed-apps:launch', app),
  openWebsiteApp: (nameOrIndex) => ipcRenderer.invoke('website-apps:open', nameOrIndex),
  openFileExplorer: () => ipcRenderer.invoke('file-explorer:open-window'),
  fileExplorerRoots: () => ipcRenderer.invoke('file-explorer:roots'),
  fileExplorerList: (rootId, rel) => ipcRenderer.invoke('file-explorer:list', rootId, rel),
  fileExplorerOpen: (rootId, rel) => ipcRenderer.invoke('file-explorer:open', rootId, rel),

  quitApp: (pin) => ipcRenderer.invoke('app:quit', pin),
  uninstallApp: (pin) => ipcRenderer.invoke('app:uninstall', pin),
  quitCancel: () => ipcRenderer.invoke('quit:cancel'),
  fitQuitWindow: (w, h) => ipcRenderer.invoke('quit:fit', w, h),
  hideWindow: () => ipcRenderer.invoke('app:hide'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  getLicense: () => ipcRenderer.invoke('license:get'),
  applyTheme: (resolved) => ipcRenderer.invoke('theme:apply', resolved),

  onStatus: (cb) => {
    const listener = (_e, status) => cb(status);
    ipcRenderer.on('status', listener);
    return () => ipcRenderer.removeListener('status', listener);
  },
  onUpdate: (cb) => {
    const listener = (_e, note) => cb(note);
    ipcRenderer.on('update', listener);
    return () => ipcRenderer.removeListener('update', listener);
  },
  onUpdateProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('update-progress', listener);
    return () => ipcRenderer.removeListener('update-progress', listener);
  },
  onSessionLock: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('session-lock', listener);
    return () => ipcRenderer.removeListener('session-lock', listener);
  },
  onNetblockError: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('netblock-error', listener);
    return () => ipcRenderer.removeListener('netblock-error', listener);
  }
});
