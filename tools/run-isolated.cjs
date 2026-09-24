#!/usr/bin/env node
/**
 * 隔离运行真实应用（人工用测试账号操作）
 *
 * 固定隔离目录（不是每次新目录），所以：
 *   登录一次测试账号 → 关闭 → 再次启动，账号仍在隔离环境里。
 *
 * 每次启动前都会对「正式版数据目录 / 默认名数据目录 / 安装版目录」做快照，
 * 关闭后用 --verify 复查，确认正式版环境零改动。
 *
 * 用法：
 *   node tools/run-isolated.cjs               # 打包 + 启动（前台，关闭窗口后返回）
 *   node tools/run-isolated.cjs --verify      # 与上次启动前快照比对，复查隔离
 *   node tools/run-isolated.cjs --skip-pack   # 不重新打包，直接启动
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

const ROOT = path.resolve(__dirname, "..");
const runtimeDir = path.join(ROOT, "runtime", "dev");
const exePath = require("./exe-name").resolveExe(runtimeDir);
const isolatedRoot = path.join(ROOT, "runtime", "isolation", "stable");
const chromiumDir = path.join(isolatedRoot, "chromium");
const snapshotPath = path.join(isolatedRoot, "before-snapshot.json");

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

function verify() {
  if (!fs.existsSync(snapshotPath)) throw new Error("没有找到启动前快照，请先正常启动一次");
  const saved = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  let clean = true;
  const result = [];
  for (const item of WATCHED) {
    const before = saved.items.find((i) => i.id === item.id);
    if (!before) continue;
    const after = snapshot(item.dir);
    const d = diff(before, after);
    const unchanged = d.added.length === 0 && d.changed.length === 0 && d.removed.length === 0;
    if (!unchanged) clean = false;
    result.push({
      目录: item.id,
      启动前项数: before.rows.length,
      现在项数: after.rows.length,
      新增: d.added.length,
      改动: d.changed.length,
      删除: d.removed.length,
      未改动: unchanged,
      新增示例: d.added.slice(0, 5),
      改动示例: d.changed.slice(0, 5),
    });
  }
  console.log(JSON.stringify({ 快照时间: saved.at, 复查结果: result, pass: clean }, null, 2));
  console.log(clean ? "\n结论：受监控目录零改动，本次运行同样保持在隔离范围内。" : "\n结论：检测到改动，请立即核对上面列出的文件。");
  process.exit(clean ? 0 : 1);
}

function main() {
  if (has("--verify")) return verify();
  if (!fs.existsSync(exePath)) throw new Error(`未找到运行时：${exePath}`);

  fs.mkdirSync(chromiumDir, { recursive: true });
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify(
      { at: new Date().toISOString(), items: WATCHED.map((w) => ({ ...w, ...snapshot(w.dir) })) },
      null,
      2
    )
  );

  if (!has("--skip-pack")) {
    const packed = spawnSync(
      process.execPath,
      [path.join(__dirname, "pack-app.cjs"), "--entry-file", path.join(__dirname, "supervised-entry.cjs")],
      { encoding: "utf8" }
    );
    if (packed.status !== 0) throw new Error(`打包失败：${packed.stderr || packed.stdout}`);
    console.log(`打包完成：${JSON.parse(packed.stdout).files} 个文件，结构自检通过`);
  }

  console.log("");
  console.log("════════════════════════════════════════════════════");
  console.log(" 隔离运行（固定目录，账号可持久保存）");
  console.log(`   隔离根：${isolatedRoot}`);
  console.log(`   Chromium 数据：${chromiumDir}`);
  console.log(`   应用数据：${path.join(isolatedRoot, "DoubaoAccountManager")}`);
  console.log("");
  console.log(" 请在这个隔离环境里操作（不会影响正式版）：");
  console.log("   1. 左侧「导入」或「＋」添加一个测试账号并完成登录");
  console.log("   2. 顶栏点「分镜工作台」→ 新建项目");
  console.log("   3. 导入参考图片 → 新增分镜 → 写提示词（输入 @ 可插入参考图）");
  console.log("   4. 选择执行账号 → 点「生成这一条」（只会提交这一条）");
  console.log("");
  console.log(" 关闭窗口后，执行复查隔离：");
  console.log("   node tools/run-isolated.cjs --verify");
  console.log("════════════════════════════════════════════════════");
  console.log("");

  const child = spawn(exePath, [`--user-data-dir=${chromiumDir}`], {
    cwd: runtimeDir,
    env: {
      ...process.env,
      DBM_ISOLATED_ROOT: isolatedRoot,
      DBM_CHROMIUM_DIR: chromiumDir,
    },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    console.log(`\n应用已退出（code=${code}）。建议接着执行：node tools/run-isolated.cjs --verify`);
  });
}

main();