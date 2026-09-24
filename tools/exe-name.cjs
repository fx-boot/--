#!/usr/bin/env node
/**
 * 运行时可执行文件名解析。
 *
 * 软件全称已改为「澜川Dola管理器」，可执行文件随之改名；
 * 但历史打包目录里可能仍是旧名「豆包管理器.exe」，
 * 因此这里统一「新名优先、旧名兜底」，避免改名后工具脚本找不到 exe。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXE_NAME = "澜川Dola管理器.exe";
const EXE_NAME_LEGACY = "豆包管理器.exe";

/** 在给定运行时目录里定位可执行文件；都不存在时返回新名路径（便于报错信息可读） */
function resolveExe(runtimeDir) {
  const candidates = [path.join(runtimeDir, EXE_NAME), path.join(runtimeDir, EXE_NAME_LEGACY)];
  return candidates.find((file) => fs.existsSync(file)) || candidates[0];
}

module.exports = { EXE_NAME, EXE_NAME_LEGACY, resolveExe };