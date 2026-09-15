/**
 * 预加载脚本：经 contextBridge 暴露最小标识，让 WebUI 主世界能识别自己跑在
 * 桌面壳里（window.isAmedacDesktop === true）。不注入任何 Node 能力。
 */
"use strict";

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("isAmedacDesktop", true);
