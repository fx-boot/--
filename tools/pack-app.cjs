#!/usr/bin/env node
/**
 * 把 app/ 源树打包成运行时使用的 resources/app.asar
 *
 * 背景（阶段 0 实测结论）：
 *   已发布 exe 中虽存在 asar 完整性标记，但其值指向“改动前”的 app.asar，
 *   而实际运行使用的是被替换过的 app.asar —— 说明该完整性校验保险丝未启用。
 *   因此重打包默认不修改 exe；仅在显式传 --patch-exe 时才按正确公式回写标记。
 *
 * 安全约束：
 *   脚本拒绝把结果写入安装版目录（含“完整便携版”字样的路径），
 *   以避免覆盖可用于回滚的安装包。运行时副本请用 runtime/dev。
 *
 * 用法：
 *   node tools/pack-app.cjs                        # 默认 source=../app runtime=../runtime/dev
 *   node tools/pack-app.cjs --entry acceptance.cjs # 验收模式：package.json main 改为该入口
 *   node tools/pack-app.cjs --entry-file <脚本>     # 把外部脚本注入包根并作为入口（用于隔离探针）
 *   node tools/pack-app.cjs --patch-exe            # 额外回写 exe 完整性标记
 *   node tools/pack-app.cjs --target <dir>         # 只写 asar 到指定目录（不要求完整运行时）
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execSync } = require("node:child_process");

const args = process.argv.slice(2);
function argValue(flag, fallback = "") {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const has = (flag) => args.includes(flag);

const ROOT = path.resolve(__dirname, "..");
const sourceDir = path.resolve(argValue("--source", path.join(ROOT, "app")));
const runtimeDir = path.resolve(argValue("--runtime", path.join(ROOT, "runtime", "dev")));
const targetDir = argValue("--target", "") ? path.resolve(argValue("--target")) : runtimeDir;
const entry = argValue("--entry", "");
const entryFile = argValue("--entry-file", "");
const patchExe = has("--patch-exe");
// 构建渠道：dev（隔离开发版，默认）/ release（正式发布版）；仅写入包内副本，不污染源码
const buildChannel = argValue("--channel", "dev");

const EXE_NAME = "豆包管理器.exe";
const INTEGRITY_MARKER = '[{"file":"resources\\\\app.asar","alg":"SHA256","value":"';

const ALIGN = 4;
const align = (n) => Math.ceil(n / ALIGN) * ALIGN;
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function assertNotInstallDir(dir) {
  if (/完整便携版/.test(dir) || /安装版/.test(dir)) {
    throw new Error(`拒绝写入疑似安装版目录：${dir}（请使用 runtime/dev 等副本目录）`);
  }
}

/** 读取当前 Git 短提交号（失败时返回空串，不阻断打包） */
function gitShortCommit() {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8").trim();
  } catch {
    return "";
  }
}

/** 递归收集文件，按名称排序保证产物可复现 */
function collect(dir, prefix = "", out = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) collect(full, rel, out);
    else out.push({ rel, full, size: stat.size });
  }
  return out;
}

/** 把扁平列表构造成 asar 的树形索引 */
function buildTree(files) {
  const root = { files: {} };
  for (const f of files) {
    const parts = f.rel.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      node.files[parts[i]] = node.files[parts[i]] || { files: {} };
      node = node.files[parts[i]];
    }
    node.files[parts[parts.length - 1]] = f.entry;
  }
  return root;
}

function buildArchive({ files, unpackedDir, entryOverride, stamp }) {
  const embedded = [];
  const index = { files: {} };
  let offset = 0;

  // 关键顺序：先读取并按需改写内容，再用“改写后的真实长度”分配偏移。
  // 早期版本先用 stat 的原始长度分配偏移、之后才改写 package.json 的 main，
  // 会让 package.json 之后的所有文件偏移错位、内容被读串（已修复，勿回退）。
  for (const f of files) {
    const isUnpacked = unpackedDir && fs.existsSync(path.join(unpackedDir, f.rel));
    if (isUnpacked) {
      f.entry = { size: f.size, unpacked: true };
      f.data = null;
      continue;
    }
    let data = fs.readFileSync(f.full);
    if (entryOverride && f.rel === "package.json") {
      const pkg = JSON.parse(data.toString("utf8"));
      pkg.main = entryOverride;
      data = Buffer.from(JSON.stringify(pkg), "utf8");
      f.rewritten = true;
    }
    // 版本构建戳：只改包内副本，源码 app/version.json 保持干净。
    // 界面通过 snapshot 读到 buildAt / buildChannel / gitCommit，可区分不同构建包。
    if (stamp && f.rel === "version.json") {
      const info = JSON.parse(data.toString("utf8"));
      info.buildAt = stamp.buildAt;
      info.buildChannel = stamp.buildChannel;
      if (stamp.gitCommit) info.gitCommit = stamp.gitCommit;
      data = Buffer.from(JSON.stringify(info, null, 2), "utf8");
      f.rewritten = true;
    }
    f.data = data;
    f.entry = { size: data.length, offset: String(offset) };
    offset += data.length;
    embedded.push(f);
  }

  const tree = buildTree(files);
  Object.assign(index.files, tree.files);

  const headerBuf = Buffer.from(JSON.stringify(index), "utf8");
  const padded = Buffer.concat([headerBuf, Buffer.alloc(align(headerBuf.length) - headerBuf.length, 0)]);
  const headerPayload = Buffer.concat([u32(headerBuf.length), padded]);
  const headerPickle = Buffer.concat([u32(headerPayload.length), headerPayload]);
  const sizePickle = Buffer.concat([u32(4), u32(headerPickle.length)]);

  return {
    archive: Buffer.concat([sizePickle, headerPickle, ...embedded.map((f) => f.data)]),
    headerBuf,
    count: files.length,
    embedded,
  };
}

/**
 * 结构自检：把刚写出的 asar 重新解析一遍，
 * 逐个文件与预期字节比对，并校验偏移连续性。
 * 这一层是为了让“偏移错位”这类缺陷在打包当场暴露，而不是等到启动时才表现成启动失败。
 */
function verifyArchive(archive, expected) {
  const jsonLength = archive.readUInt32LE(12);
  const headerText = archive.subarray(16, 16 + jsonLength).toString("utf8").replace(/\u0000+$/, "");
  const index = JSON.parse(headerText);
  const base = 8 + archive.readUInt32LE(4);
  if (base !== align(jsonLength) + 16) {
    throw new Error(`结构自检失败：base(${base}) 与对齐后的头部长度(${align(jsonLength) + 16}) 不一致`);
  }

  const problems = [];
  const flat = [];
  (function walk(files, prefix = "") {
    for (const [name, entry] of Object.entries(files || {})) {
      const key = prefix + name;
      if (entry.files) walk(entry.files, key + "/");
      else flat.push({ key, entry });
    }
  })(index.files);

  if (flat.length !== expected.files.length) {
    problems.push(`条目数不符：包内 ${flat.length}，预期 ${expected.files.length}`);
  }

  for (const f of expected.files) {
    const parts = f.rel.split("/");
    let node = index;
    for (const p of parts) node = node && node.files ? node.files[p] : null;
    if (!node) {
      problems.push(`包内缺少条目：${f.rel}`);
      continue;
    }
    if (node.unpacked) {
      if (f.data !== null) problems.push(`解包标记与实际不符：${f.rel}`);
      continue;
    }
    const start = base + Number(node.offset);
    const actual = archive.subarray(start, start + node.size);
    if (actual.length !== node.size) {
      problems.push(`读取越界：${f.rel}`);
      continue;
    }
    if (f.data && !actual.equals(f.data)) {
      problems.push(`内容比对失败（偏移错位或改写不一致）：${f.rel}`);
    }
  }

  return { checked: flat.length, problems };
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function main() {
  if (!fs.existsSync(sourceDir)) throw new Error(`源树不存在：${sourceDir}`);
  assertNotInstallDir(targetDir);

  const all = collect(sourceDir);

  // 入口脚本注入：把 tools/ 下的外部脚本放到包根，并让 package.json 指向它。
  // 这样验收/探针代码不会污染 app/ 基线源树。
  let entryOverride = entry;
  if (entryFile) {
    const abs = path.resolve(entryFile);
    if (!fs.existsSync(abs)) throw new Error(`入口脚本不存在：${abs}`);
    const base = path.basename(abs);
    if (all.some((f) => f.rel === base)) throw new Error(`包内已存在同名文件：${base}`);
    all.push({ rel: base, full: abs, size: fs.statSync(abs).size });
    entryOverride = base;
  }

  // node_modules 必须随包发布；png/pem 等一并包含，不做白名单
  const unpackedDir = path.join(runtimeDir, "resources", "app.asar.unpacked");
  const stamp = {
    buildAt: new Date().toISOString(),
    buildChannel,
    gitCommit: gitShortCommit(),
  };
  const { archive, headerBuf, count } = buildArchive({ files: all, unpackedDir, entryOverride, stamp });

  // 结构自检先于落盘：一旦偏移/内容不一致就直接失败，不产出坏包
  const selfCheck = verifyArchive(archive, { files: all });
  if (selfCheck.problems.length) {
    throw new Error(`结构自检失败（${selfCheck.problems.length} 项）：\n  - ${selfCheck.problems.join("\n  - ")}`);
  }

  const outAsar = path.join(targetDir, "resources", "app.asar");
  fs.mkdirSync(path.dirname(outAsar), { recursive: true });
  const temp = `${outAsar}.building`;
  fs.writeFileSync(temp, archive);
  fs.renameSync(temp, outAsar);

  const sourceVersion = JSON.parse(
    fs.readFileSync(path.join(sourceDir, "version.json"), "utf8")
  );
  const result = {
    version: `v${sourceVersion.version}`,
    channel: buildChannel,
    gitCommit: stamp.gitCommit || "(无)",
    buildAt: stamp.buildAt,
    source: sourceDir,
    asar: outAsar,
    files: count,
    bytes: archive.length,
    entry: entryOverride || "(package.json 原值)",
    headerSha256: sha256(headerBuf),
    selfCheck: `通过（${selfCheck.checked} 条目逐个字节比对）`,
    patchExe: false,
  };

  if (patchExe) {
    const exePath = path.join(targetDir, EXE_NAME);
    if (!fs.existsSync(exePath)) throw new Error(`未找到 exe：${exePath}`);
    const buf = fs.readFileSync(exePath);
    const marker = Buffer.from(INTEGRITY_MARKER);
    const at = buf.indexOf(marker);
    if (at < 0) throw new Error("exe 中未找到 asar 完整性标记，无法回写");
    const value = sha256(headerBuf).toUpperCase();
    value.split("").forEach((ch, i) => {
      buf[at + marker.length + i] = ch.charCodeAt(0);
    });
    const out = `${exePath}.building`;
    fs.writeFileSync(out, buf);
    fs.renameSync(out, exePath);
    result.patchExe = true;
  }

  console.log(JSON.stringify(result, null, 2));
}

main();