#!/usr/bin/env node
/**
 * 启动 dev 运行时（runtime/dev），默认使用隔离的用户数据目录。
 *
 * 安全约束（重要）：
 *   本脚本强制使用 --user-data-dir 指向项目内 runtime/dev-data 下的目录，
 *   绝不复用 %APPDATA%\DoubaoAccountManager 中的真实账号数据。
 *   真实数据目录只做“未改动”比对，不做任何写入。
 *
 * 用法：
 *   node tools/run-dev.cjs --check            # 打包前置+启动探测+自动关闭，输出 JSON 结论
 *   node tools/run-dev.cjs --pack             # 先重新打包再启动
 *   node tools/run-dev.cjs --data <dir>       # 指定隔离数据目录
 *   node tools/run-dev.cjs --seconds 25       # 探测时长
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const argValue = (flag, fallback = "") => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (flag) => args.includes(flag);

const ROOT = path.resolve(__dirname, "..");
const runtimeDir = path.resolve(argValue("--runtime", path.join(ROOT, "runtime", "dev")));
const exePath = path.join(runtimeDir, "豆包管理器.exe");
const dataDir = path.resolve(
  argValue("--data", path.join(ROOT, "runtime", "dev-data", `boot-${Date.now()}`))
);
const seconds = Number(argValue("--seconds", "20"));
const realUserData = path.join(process.env.APPDATA || "", "DoubaoAccountManager");

function listTop(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return null;
  }
}

function newestMtime(dir) {
  let newest = 0;
  try {
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      for (const name of fs.readdirSync(cur)) {
        const full = path.join(cur, name);
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) stack.push(full);
        else newest = Math.max(newest, st.mtimeMs);
      }
    }
  } catch {
    return null;
  }
  return newest;
}

function main() {
  if (has("--pack")) {
    const r = spawnSync(process.execPath, [path.join(__dirname, "pack-app.cjs")], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("打包失败，已中止启动");
  }
  if (!fs.existsSync(exePath)) throw new Error(`未找到运行时 exe：${exePath}`);
  if (/完整便携版|安装版/.test(dataDir)) throw new Error("数据目录不得指向安装版目录");

  fs.mkdirSync(dataDir, { recursive: true });

  const before = {
    realUserDataExists: fs.existsSync(realUserData),
    realUserDataMtime: newestMtime(realUserData),
    realUserDataEntries: listTop(realUserData),
  };

  const child = spawn(exePath, [`--user-data-dir=${dataDir}`], {
    cwd: runtimeDir,
    stdio: "ignore",
    detached: false,
  });

  const result = {
    exe: exePath,
    pid: child.pid,
    isolatedDataDir: dataDir,
    realUserDataUntouched: null,
    alive: false,
    exitCode: null,
    dataDirTop: null,
    bootOk: false,
    notes: [],
  };

  let exited = null;
  child.on("exit", (code) => {
    exited = code;
    result.exitCode = code;
  });
  child.on("error", (err) => {
    exited = -1;
    result.exitCode = -1;
    result.notes.push(`spawn error: ${err.message}`);
  });

  const finish = () => {
    result.alive = exited === null;
    result.dataDirTop = listTop(dataDir);
    const afterMtime = newestMtime(realUserData);
    result.realUserDataUntouched =
      before.realUserDataMtime === afterMtime &&
      JSON.stringify(before.realUserDataEntries) === JSON.stringify(listTop(realUserData));

    if (before.realUserDataExists && !result.realUserDataUntouched) {
      result.notes.push("警告：真实用户数据目录发生变化，需人工确认");
    }
    // 判定启动成功：进程在探测期间存活，且隔离目录被 Electron 实际写入
    result.bootOk = result.alive && Array.isArray(result.dataDirTop) && result.dataDirTop.length > 0;
    if (!result.alive) result.notes.push(`进程在 ${seconds}s 内退出（exitCode=${result.exitCode}）`);
    if (result.alive && (result.dataDirTop || []).length === 0) result.notes.push("隔离数据目录为空，Electron 可能未真正启动");

    if (result.alive) {
      try {
        process.kill(child.pid);
      } catch {}
    }
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.bootOk ? 0 : 1);
  };

  if (has("--check")) setTimeout(finish, Math.max(5, seconds) * 1000);
  else {
    console.log(JSON.stringify({ exe: exePath, pid: child.pid, isolatedDataDir: dataDir }, null, 2));
    child.unref();
  }
}

main();