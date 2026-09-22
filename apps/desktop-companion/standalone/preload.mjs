import { contextBridge, ipcRenderer } from "electron";
import { installDesktopProviderPreload } from "../src/provider-workspace-ipc.js";

installDesktopProviderPreload(contextBridge, ipcRenderer);
