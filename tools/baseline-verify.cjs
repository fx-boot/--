#!/usr/bin/env node
/**
 * 基线一致性校验
 *
 * 用途：确认 app/ 源树与某个已发布 app.asar 是否字节一致。
 * 这是判断“哪份源码是发布基线”的唯一可靠依据，不依赖目录名或修改时间。
 *
 * 用法：
 *   node tools/baseline-verify.cjs <app.asar 路径> [源树目录，默认 ../app]
 *
 * 退出码：0 = 完全一致；1 = 存在差异（差异明细打印到 stdout）
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/** 解析 asar，返回 { index, base, data } */
function readArchive(file) {
  const data = fs.readFileSync(file);
  const jsonLength = data.readUInt32LE(12);
  const headerStart = 16;
  const raw = data.subarray(headerStart, headerStart + jsonLength).toString("utf8");
  const index = JSON.parse(raw.replace(/\u0000+$/, ""));
  // headerPickle = [u32 payloadSize][payload]; headerPayload = [u32 jsonLength][json...]
  const base = 8 + data.readUInt32LE(4);
  return { index, base, data };
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function flatten(files, prefix = "", out = []) {
  for (const [name, entry] of Object.entries(files || {})) {
    const key = prefix + name;
    if (entry.files) flatten(entry.files, key + "/", out);
    else out.push({ key, entry });
  }
  return out;
}

function main() {
  const asarPath = process.argv[2];
  if (!asarPath) {
    console.error("用法: node tools/baseline-verify.cjs <app.asar> [源树目录]");
    process.exit(2);
  }
  const sourceDir = path.resolve(process.argv[3] || path.join(__dirname, "..", "app"));
  const { index, base, data } = readArchive(asarPath);
  const entries = flatten(index.files);

  const rows = [];
  const unpacked = [];
  for (const { key, entry } of entries) {
    if (entry.link) continue;
    if (entry.unpacked) {
      unpacked.push({ key, size: entry.size });
      continue;
    }
    const asarBuf = data.subarray(base + Number(entry.offset), base + Number(entry.offset) + entry.size);
    const asarHash = sha256(asarBuf);
    let srcHash = "MISSING_IN_SOURCE";
    const full = path.join(sourceDir, key);
    if (full.startsWith(sourceDir + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      srcHash = sha256(fs.readFileSync(full));
    }
    rows.push({ key, asarHash, srcHash, size: entry.size });
  }

  // 源树里多出来的文件：发布包不应缺少它们，但多余文件也不该被静默忽略
  const asarKeys = new Set(entries.filter((e) => !e.link).map((e) => e.key));
  const extra = [];
  (function walk(dir, prefix = "") {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = prefix + name;
      if (fs.statSync(full).isDirectory()) walk(full, rel + "/");
      else if (!asarKeys.has(rel)) extra.push(rel);
    }
  })(sourceDir);

  const mismatched = rows.filter((r) => r.asarHash !== r.srcHash);
  const unpackedMissing = unpacked.filter((u) => !fs.existsSync(path.join(sourceDir, u.key)));

  console.log(`asar:   ${asarPath}`);
  console.log(`source: ${sourceDir}`);
  console.log(`条目  在包内=${rows.length}  解包=${unpacked.length}`);
  console.log(`一致=${rows.length - mismatched.length}  不一致=${mismatched.length}  源树多出=${extra.length}  解包缺失=${unpackedMissing.length}`);

  for (const r of mismatched) {
    const tag = r.srcHash === "MISSING_IN_SOURCE" ? "源树缺失  " : "内容不一致";
    console.log(`  [${tag}] ${r.key}`);
  }
  for (const k of extra) console.log(`  [源树多出  ] ${k}`);
  for (const u of unpackedMissing) console.log(`  [解包缺失  ] ${u.key}`);

  const ok = mismatched.length === 0 && extra.length === 0 && unpackedMissing.length === 0;
  console.log(ok ? "\n结论：基线完全一致。" : "\n结论：存在差异，不能视为发布基线。");
  process.exit(ok ? 0 : 1);
}

main();