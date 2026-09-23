#!/usr/bin/env node
/**
 * 运行端到端流程探针：在隔离环境里跑完整链路，并复查受监控目录零改动。
 *
 * 与 isolation-verify.cjs 使用同一套快照规则（路径+大小，递归排序后取摘要）。
 * 之所以单列一个脚本：本探针只关注工作台流程结论，判定口径与启动探针不同。
 *
 * 不执行任何真实生成，不消耗任何账号额度。
 *
 * 用法：node tools/run-flow-probe.cjs [--seconds 180]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

const args = process.argv.slice(2);
const argValue = (flag, fallback = "") => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const waitSeconds = Number(argValue("--seconds", "180"));

const ROOT = path.resolve(__dirname, "..");
const runtimeDir = path.join(ROOT, "runtime", "dev");
const exePath = path.join(runtimeDir, "豆包管理器.exe");
const reportPath = path.join(runtimeDir, "flow-probe-report.json");
const isolatedRoot = path.join(ROOT, "runtime", "isolation", `flow-${Date.now()}`);
const chromiumDir = path.join(isolatedRoot, "chromium");

const WATCHED = [
  { id: "正式版数据目录", dir: path.join(process.env.APPDATA || "", "DoubaoAccountManager") },
  { id: "默认名数据目录", dir: path.join(process.env.APPDATA || "", "doubao-account-manager") },
  { id: "安装版目录", dir: path.join("C:\\Users\\Administrator\\Desktop\\工具", "豆包管理器-V2.0-完整便携版(1)") },
];

function snapshot(dir) {
  const rows = [];
  (function walk(current) {
    let names;
    try {
      names = fs.readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
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

function diff(before, after) {
  const b = new Map(before.rows.map((r) => [r.split("|").slice(0, 2).join("|"), r]));
  const a = new Map(after.rows.map((r) => [r.split("|").slice(0, 2).join("|"), r]));
  const added = [];
  const changed = [];
  const removed = [];
  for (const [k, r] of a) {
    if (!b.has(k)) added.push(r);
    else if (b.get(k) !== r) changed.push(r);
  }
  for (const [k, r] of b) if (!a.has(k)) removed.push(r);
  return { added, changed, removed };
}

function main() {
  if (!fs.existsSync(exePath)) throw new Error(`未找到运行时：${exePath}`);
  fs.mkdirSync(chromiumDir, { recursive: true });

  console.log("── 1/4 启动前快照 ──");
  const before = WATCHED.map((w) => ({ ...w, snap: snapshot(w.dir) }));
  for (const item of before) {
    console.log(`  ${item.id}: ${item.snap.exists ? `${item.snap.rows.length} 项` : "不存在"}`);
  }

  console.log("── 2/4 打包（注入端到端流程探针） ──");
  const packed = spawnSync(
    process.execPath,
    [path.join(__dirname, "pack-app.cjs"), "--entry-file", path.join(__dirname, "workbench-flow-probe.cjs")],
    { encoding: "utf8" }
  );
  if (packed.status !== 0) throw new Error(`打包失败：${packed.stderr || packed.stdout}`);
  console.log(`  ${JSON.parse(packed.stdout).files} 个文件，结构自检通过`);

  console.log("── 3/4 隔离启动并跑完整流程 ──");
  try {
    fs.unlinkSync(reportPath);
  } catch {}
  const child = spawn(exePath, [`--user-data-dir=${chromiumDir}`], {
    cwd: runtimeDir,
    env: { ...process.env, DBM_ISOLATED_ROOT: isolatedRoot, DBM_CHROMIUM_DIR: chromiumDir },
    stdio: "ignore",
    detached: false,
  });
  console.log(`  pid=${child.pid}  isolatedRoot=${isolatedRoot}`);

  const deadline = Date.now() + waitSeconds * 1000;
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let report = null;
  while (Date.now() < deadline) {
    try {
      report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      break;
    } catch {}
    sleepSync(500);
  }
  try {
    process.kill(child.pid);
  } catch {}
  if (!report) throw new Error(`等待 ${waitSeconds}s 未取得流程报告`);

  console.log("── 4/4 复查受监控目录 ──");
  let clean = true;
  const watched = [];
  for (const item of before) {
    const after = snapshot(item.dir);
    const d = diff(item.snap, after);
    const unchanged = d.added.length === 0 && d.changed.length === 0 && d.removed.length === 0;
    if (!unchanged) clean = false;
    watched.push({
      目录: item.id,
      启动前项数: item.snap.rows.length,
      现在项数: after.rows.length,
      新增: d.added.length,
      改动: d.changed.length,
      删除: d.removed.length,
      未改动: unchanged,
      新增示例: d.added.slice(0, 5),
    });
  }

  const failed = (report.checks || []).filter((c) => !c.pass);
  const verdict = {
    隔离复查: watched,
    流程通过项: (report.checks || []).filter((c) => c.pass).length,
    流程检查总数: (report.checks || []).length,
    未通过项: failed.map((c) => ({ name: c.name, detail: c.detail })),
    渲染层控制台错误: report.consoleErrors,
    渲染层加载问题: report.pageErrors,
    环境: { electron: report.electron, chrome: report.chrome },
    pass: clean && Boolean(report.ok),
  };

  console.log("");
  console.log(JSON.stringify(report.steps, null, 2));
  console.log("");
  console.log(JSON.stringify(verdict, null, 2));
  console.log("");
  console.log(verdict.pass ? "结论：隔离有效且工作台端到端流程全部通过。"
    : "结论：存在未通过项，见上面「未通过项」。");
  process.exit(verdict.pass ? 0 : 1);
}

main();