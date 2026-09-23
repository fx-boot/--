#!/usr/bin/env node
/**
 * 还原 app/node_modules（阶段 0 列为待补项）
 *
 * 原因：node_modules 约 79MB，不入版本库；但打包需要它（bytenode、ffmpeg-static 等）。
 * 它可从安装包的 app.asar 内同名目录还原，因此本脚本让其可重现。
 *
 * 只还原 node_modules/**，不触碰 app/src、app/renderer（那些由版本库管理）。
 *
 * 用法：
 *   node tools/restore-deps.cjs                       # 默认从安装版读取
 *   node tools/restore-deps.cjs --from <便携版目录>    # 指定来源
 *   node tools/restore-deps.cjs --force               # 覆盖已存在的文件
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const argValue = (flag, fallback = "") => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const force = args.includes("--force");

const ROOT = path.resolve(__dirname, "..");
const target = path.join(ROOT, "app");
const releaseDir = path.resolve(
  argValue(
    "--from",
    "C:\\Users\\Administrator\\Desktop\\工具\\豆包管理器-V2.0-完整便携版(1)\\豆包管理器-V2.0-完整便携版"
  )
);
const asarPath = path.join(releaseDir, "resources", "app.asar");
const unpackedDir = path.join(releaseDir, "resources", "app.asar.unpacked");

function flatten(files, prefix = "", out = []) {
  for (const [name, entry] of Object.entries(files || {})) {
    const key = prefix + name;
    if (entry.files) flatten(entry.files, key + "/", out);
    else out.push({ key, entry });
  }
  return out;
}

function main() {
  if (!fs.existsSync(asarPath)) throw new Error(`找不到来源 app.asar：${asarPath}`);
  const data = fs.readFileSync(asarPath);
  const jsonLength = data.readUInt32LE(12);
  const index = JSON.parse(
    data.subarray(16, 16 + jsonLength).toString("utf8").replace(/\u0000+$/, "")
  );
  const base = 8 + data.readUInt32LE(4);
  const entries = flatten(index.files).filter(
    (e) => e.key.startsWith("node_modules/") && !e.entry.link
  );

  let written = 0;
  let skipped = 0;
  let unpackedCopied = 0;
  for (const { key, entry } of entries) {
    // 路径安全：不允许越出 app/
    const full = path.join(target, key);
    if (!full.startsWith(target + path.sep)) throw new Error(`路径越界：${key}`);
    if (!force && fs.existsSync(full)) {
      skipped++;
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (entry.unpacked) {
      const source = path.join(unpackedDir, key);
      if (!fs.existsSync(source)) {
        console.warn(`  跳过解包文件（来源缺失）：${key}`);
        skipped++;
        continue;
      }
      fs.copyFileSync(source, full);
      unpackedCopied++;
    } else {
      fs.writeFileSync(
        full,
        data.subarray(base + Number(entry.offset), base + Number(entry.offset) + entry.size)
      );
    }
    written++;
  }

  console.log(
    JSON.stringify(
      {
        source: asarPath,
        target: path.join(target, "node_modules"),
        还原文件: written,
        其中解包文件: unpackedCopied,
        已存在跳过: skipped,
        覆盖模式: force,
      },
      null,
      2
    )
  );
}

main();