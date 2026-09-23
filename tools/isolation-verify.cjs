#!/usr/bin/env node
/**
 * 隔离有效性验证（控制器，运行在 Node 侧）
 *
 * 做法：
 *   1. 启动前对「正式版数据目录 / 默认名目录 / 安装版目录」做递归快照（路径+大小+mtime）；
 *   2. 用 --entry-file 注入 tools/boot-probe.cjs 打包；
 *   3. 用 --user-data-dir 指向隔离目录启动 dev 运行时（拦 Chromium 预初始化），
 *      同时通过 DBM_ISOLATED_ROOT 让探针把 app.setPath 也改道到同一隔离根（拦 main.jsc 的重设）；
 *   4. 等探针产出报告后，重新快照并逐一比对；
 *   5. 只有「探针自检通过 + 隔离目录确有内容 + 受监控目录零新增零改动」才算隔离有效。
 *
 * 不提交任何生成任务，不消耗任何账号额度。
 *
 * 用法：node tools/isolation-verify.cjs [--seconds 120]
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

const args = process.argv.slice(2);
const argValue = (flag, fallback = "") => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const waitSeconds = Number(argValue("--seconds", "120"));
const supervised = args.includes("--supervised");

const ROOT = path.resolve(__dirname, "..");
const runtimeDir = path.join(ROOT, "runtime", "dev");
const exePath = path.join(runtimeDir, "豆包管理器.exe");
const reportPath = path.join(runtimeDir, "boot-probe-report.json");
const isolatedRoot = path.join(ROOT, "runtime", "isolation", supervised ? "stable" : `run-${Date.now()}`);
/** 受控入口模式读 launch-record.json；探针模式读 boot-probe-report.json */
const recordPath = supervised ? path.join(isolatedRoot, "launch-record.json") : reportPath;
const entryFile = supervised ? "supervised-entry.cjs" : "boot-probe.cjs";

/** 受监控目录：这些目录在任何情况下都不该被测试运行改动 */
const WATCHED = [
  { id: "正式版数据目录", dir: path.join(process.env.APPDATA || "", "DoubaoAccountManager") },
  { id: "默认名数据目录", dir: path.join(process.env.APPDATA || "", "doubao-account-manager") },
  { id: "安装版目录", dir: path.join("C:\\Users\\Administrator\\Desktop\\工具", "豆包管理器-V2.0-完整便携版(1)") },
];

function snapshot(dir, limit = 200000) {
  const rows = [];
  let count = 0;
  (function walk(current) {
    let names;
    try {
      names = fs.readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      if (++count > limit) return;
      const full = path.join(current, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      const rel = path.relative(dir, full);
      if (stat.isDirectory()) {
        rows.push(`D|${rel}`);
        walk(full);
      } else {
        rows.push(`F|${rel}|${stat.size}`);
      }
    }
  })(dir);
  rows.sort();
  return { exists: fs.existsSync(dir), rows, digest: crypto.createHash("sha256").update(rows.join("\n")).digest("hex") };
}

function diffSnapshots(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  const beforeMap = new Map(before.rows.map((r) => [r.split("|").slice(0, 2).join("|"), r]));
  const afterMap = new Map(after.rows.map((r) => [r.split("|").slice(0, 2).join("|"), r]));
  for (const [key, row] of afterMap) {
    if (!beforeMap.has(key)) added.push(row);
    else if (beforeMap.get(key) !== row) changed.push(row);
  }
  for (const [key, row] of beforeMap) if (!afterMap.has(key)) removed.push(row);
  return { added, removed, changed };
}

function main() {
  if (!fs.existsSync(exePath)) throw new Error(`未找到运行时：${exePath}`);

  fs.mkdirSync(isolatedRoot, { recursive: true });
  const chromiumDir = path.join(isolatedRoot, "chromium");

  console.log("── 1/4 启动前快照 ──");
  const before = WATCHED.map((w) => ({ ...w, snap: snapshot(w.dir) }));
  for (const item of before) {
    console.log(`  ${item.id}: ${item.snap.exists ? `${item.snap.rows.length} 项` : "不存在"}  digest=${item.snap.digest.slice(0, 12)}`);
  }

  console.log("── 2/4 打包（注入隔离探针） ──");
  const packed = spawnSync(process.execPath, [path.join(__dirname, "pack-app.cjs"), "--entry-file", path.join(__dirname, entryFile)], {
    encoding: "utf8",
  });
  if (packed.status !== 0) throw new Error(`打包失败：${packed.stderr || packed.stdout}`);
  console.log(`  ${JSON.parse(packed.stdout).files} 个文件，自检通过`);

  console.log("── 3/4 以隔离参数启动 ──");
  try {
    fs.unlinkSync(recordPath);
  } catch {}
  const child = spawn(exePath, [`--user-data-dir=${chromiumDir}`], {
    cwd: runtimeDir,
    env: { ...process.env, DBM_ISOLATED_ROOT: isolatedRoot, DBM_CHROMIUM_DIR: chromiumDir },
    stdio: "ignore",
    detached: false,
  });
  console.log(`  pid=${child.pid}  isolatedRoot=${isolatedRoot}`);
  console.log(`  等待${supervised ? "受控入口记录" : "探针报告"}…`);

  const deadline = Date.now() + waitSeconds * 1000;
  const settleSeconds = Number(argValue("--settle", "20"));
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let record = null;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      // 受控入口先写一次（可能尚未 whenReady），等 mainLoaded 落定后再多留一点时间
      if (!supervised || parsed.mainLoaded === true) {
        record = parsed;
        if (supervised) sleepSync(settleSeconds * 1000);
        record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        break;
      }
    } catch {}
    sleepSync(500);
  }
  try {
    process.kill(child.pid);
  } catch {}
  if (!record) throw new Error(`等待 ${waitSeconds}s 未取得${supervised ? "受控入口记录" : "探针报告"}`);

  console.log("── 4/4 启动后再快照并比对 ──");
  const verdict = { watched: [], isolated: {}, probe: {} };
  let clean = true;
  for (const item of before) {
    const after = snapshot(item.dir);
    const d = diffSnapshots(item.snap, after);
    const unchanged = d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
    if (!unchanged) clean = false;
    verdict.watched.push({
      目录: item.id,
      path: item.dir,
      启动前项数: item.snap.rows.length,
      启动后项数: after.rows.length,
      新增: d.added.length,
      删除: d.removed.length,
      改动: d.changed.length,
      未改动: unchanged,
      新增示例: d.added.slice(0, 5),
      改动示例: d.changed.slice(0, 5),
    });
  }

  const workbenchDir = path.join(isolatedRoot, "DoubaoAccountManager", "workbench");
  const countFiles = (dir) => {
    let n = 0;
    (function walk(cur) {
      let names;
      try {
        names = fs.readdirSync(cur);
      } catch {
        return;
      }
      for (const name of names) {
        const full = path.join(cur, name);
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) walk(full);
        else n++;
      }
    })(dir);
    return n;
  };

  verdict.isolated = {
    root: isolatedRoot,
    顶层: fs.existsSync(isolatedRoot) ? fs.readdirSync(isolatedRoot).sort() : null,
    userData实际落点: supervised ? record.userDataApplied : record.userDataAfterRedirect,
    userData在隔离内: String((supervised ? record.userDataApplied : record.userDataAfterRedirect) || "").startsWith(isolatedRoot),
    工作台数据目录在隔离内: supervised
      ? fs.existsSync(workbenchDir)
      : String(record.workbench?.storageRoot || "").startsWith(isolatedRoot),
    隔离目录文件数: countFiles(isolatedRoot),
    electron确实写入了隔离目录: countFiles(isolatedRoot) > 0,
    数据目录请求: (record.pathRequests || []).length,
  };

  verdict.probe = supervised
    ? {
        mainLoaded: record.mainLoaded,
        chromiumUserDataDir: record.chromiumUserDataDir,
        数据目录请求: (record.pathRequests || []).length,
        错误: record.error,
      }
    : {
        ok: record.ok,
        mainLoaded: record.mainLoaded,
        ready: record.ready,
        通过项数: (record.checks || []).filter((c) => c.pass).length,
        检查项总数: (record.checks || []).length,
        未通过的检查: (record.checks || []).filter((c) => !c.pass).map((c) => c.name),
        工作台数据目录: record.workbench?.storageRoot,
        诊断: (record.diagnostics || []).slice(0, 5),
        错误: record.error,
      };

  const isolatedValid =
    verdict.isolated.userData在隔离内 &&
    verdict.isolated.工作台数据目录在隔离内 &&
    verdict.isolated.electron确实写入了隔离目录;
  const entryOk = supervised
    ? record.mainLoaded === true && !record.error
    : Boolean(record.ok);

  verdict.pass = clean && isolatedValid && entryOk;

  console.log("");
  console.log(JSON.stringify(verdict, null, 2));
  console.log("");
  console.log(
    verdict.pass
      ? "结论：隔离有效 —— 受监控目录零改动，且应用数据确实落在隔离目录内。"
      : "结论：隔离未通过验证，不要继续实机测试。"
  );
  process.exit(verdict.pass ? 0 : 1);
}

main();