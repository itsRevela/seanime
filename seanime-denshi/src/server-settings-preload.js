const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("serverSettings", {
    get: () => ipcRenderer.invoke("server-settings:get"),
    save: (payload) => ipcRenderer.invoke("server-settings:save", payload),
    relaunch: () => ipcRenderer.invoke("server-settings:relaunch"),
    close: () => ipcRenderer.invoke("server-settings:close"),
})
