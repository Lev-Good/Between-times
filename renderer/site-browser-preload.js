'use strict';

// הגשר של חלון הדפדפן המוגבל (מצב "כל האתרים פתוחים חוץ מהרשימה").
// חשוף רק את פעולות שורת הכתובת — שום דבר אחר מהתהליך הראשי. התוכן הרשתי
// עצמו נטען ב-WebContentsView נפרד ללא preload, ולכן אינו נחשף ל-API הזה.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('siteBrowser', {
  getState: () => ipcRenderer.invoke('site-browser:state'),
  navigate: (url) => ipcRenderer.invoke('site-browser:navigate', url),
  back: () => ipcRenderer.invoke('site-browser:back'),
  home: () => ipcRenderer.invoke('site-browser:home'),
  reload: () => ipcRenderer.invoke('site-browser:reload'),
  onState: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('site-browser:state', listener);
    return () => ipcRenderer.removeListener('site-browser:state', listener);
  }
});
