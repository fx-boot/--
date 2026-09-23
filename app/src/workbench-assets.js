"use strict";
/**
 * 素材库
 *
 * 关键约定：
 * - 导入即「复制」进项目素材目录（<userData>/workbench/projects/<项目>/assets/），
 *   原文件之后被移动或改名都不影响项目。
 * - assetId 由内容 sha256 派生：同一张图重复导入会复用同一个 assetId，
 *   分镜里的引用因此天然稳定；改名只改展示名，不动 assetId。
 * - 渲染层受 CSP 限制（img-src 'self' https: data:），file:// 图片无法直接显示，
 *   所以缩略图与预览都以 data: URL 返回。
 * - 删除前必须能回答「被哪些分镜引用」，由调用方（service）拿到引用清单后再执行。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]);
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
};
const MAX_BYTES = 50 * 1024 * 1024;
const THUMB_WIDTH = 256;
const SCHEMA_VERSION = 1;

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const text = (value, max = 0) => {
  const out = String(value ?? "");
  return max > 0 ? out.slice(0, max) : out;
};

function readCatalog(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    const assets = Array.isArray(value?.assets) ? value.assets : [];
    return { schemaVersion: SCHEMA_VERSION, assets };
  } catch {
    return { schemaVersion: SCHEMA_VERSION, assets: [] };
  }
}

async function writeCatalog(file, catalog) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, file);
}

function createAssets(store) {
  // 注意：这里的缓存变量名不能叫 thumbs —— dirs() 返回的 thumbs 是缩略图目录，
  // 一旦同名，remove() 里的解构会把它遮蔽成字符串，thumbs.delete 就会报 TypeError。
  const thumbCache = new Map(); // assetId -> data URL，进程内缓存，避免每次列表都重算

  function dirs(projectId) {
    return {
      assets: store.assetsDir(projectId),
      thumbs: store.thumbsDir(projectId),
      catalog: store.assetCatalogFile(projectId),
    };
  }

  function publicView(asset) {
    return {
      id: asset.id,
      name: asset.name,
      fileName: asset.fileName,
      ext: asset.ext,
      bytes: asset.bytes,
      sha256: asset.sha256,
      width: asset.width,
      height: asset.height,
      importedAt: asset.importedAt,
      hasThumb: Boolean(asset.hasThumb),
    };
  }

  async function list(projectId, options = {}) {
    const { catalog } = dirs(projectId);
    const all = readCatalog(catalog).assets.map(publicView);
    const keyword = text(options.search).trim().toLowerCase();
    const filtered = keyword
      ? all.filter(
          (a) =>
            a.name.toLowerCase().includes(keyword) ||
            a.fileName.toLowerCase().includes(keyword) ||
            a.id.toLowerCase().includes(keyword)
        )
      : all;
    return filtered.sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
  }

  async function findAsset(projectId, assetId) {
    const { catalog } = dirs(projectId);
    return readCatalog(catalog).assets.find((a) => a.id === assetId) || null;
  }

  function safePath(projectDir, fileName) {
    const full = path.join(projectDir, fileName);
    if (!full.startsWith(projectDir + path.sep)) throw new Error("素材路径越界");
    return full;
  }

  async function buildThumb(projectId, asset) {
    const { assets, thumbs } = dirs(projectId);
    const source = safePath(assets, asset.fileName);
    const target = safePath(thumbs, `${asset.id}.png`);
    try {
      const { nativeImage } = require("electron");
      const image = nativeImage.createFromPath(source);
      if (image.isEmpty()) return false;
      const size = image.getSize();
      const resized = size.width > THUMB_WIDTH ? image.resize({ width: THUMB_WIDTH }) : image;
      await fsp.writeFile(target, resized.toPNG());
      return true;
    } catch {
      return false;
    }
  }

  /** 落盘一张已经在内存里的图片；内容重复直接复用（assetId 由 sha256 派生） */
  async function commitBuffer(projectId, catalog, buffer, ext, name) {
    const { assets } = dirs(projectId);
    const hash = sha256(buffer);
    const existing = catalog.assets.find((a) => a.sha256 === hash);
    if (existing) return { reused: true, view: publicView(existing) };

    const id = `asset_${hash.slice(0, 12)}`;
    const fileName = `${id}${ext}`;
    // 先写临时文件再改名，避免出现半截素材
    const targetTmp = safePath(assets, `${fileName}.tmp`);
    const target = safePath(assets, fileName);
    await fsp.writeFile(targetTmp, buffer);
    await fsp.rename(targetTmp, target);

    const asset = {
      id,
      name,
      fileName,
      ext,
      bytes: buffer.length,
      sha256: hash,
      width: 0,
      height: 0,
      importedAt: new Date().toISOString(),
      hasThumb: false,
    };
    try {
      const { nativeImage } = require("electron");
      const size = nativeImage.createFromPath(target).getSize();
      asset.width = size.width || 0;
      asset.height = size.height || 0;
    } catch {}
    asset.hasThumb = await buildThumb(projectId, asset);

    catalog.assets.push(asset);
    return { reused: false, view: publicView(asset) };
  }

  /** 导入一批文件路径；返回 { imported, reused, failed } */
  async function importPaths(projectId, filePaths) {
    const { assets, catalog } = dirs(projectId);
    await fsp.mkdir(assets, { recursive: true });
    const current = readCatalog(catalog);
    const imported = [];
    const reused = [];
    const failed = [];

    for (const raw of filePaths || []) {
      const source = path.resolve(String(raw || ""));
      try {
        const stat = await fsp.stat(source);
        if (!stat.isFile()) throw new Error("不是文件");
        if (stat.size > MAX_BYTES) throw new Error(`超过 ${MAX_BYTES / 1024 / 1024}MB 上限`);
        const ext = path.extname(source).toLowerCase();
        if (!IMAGE_EXT.has(ext)) throw new Error(`不支持的图片格式 ${ext || "(无扩展名)"}`);
        const buffer = await fsp.readFile(source);
        const result = await commitBuffer(
          projectId,
          current,
          buffer,
          ext,
          path.basename(source, ext) || `asset_${sha256(buffer).slice(0, 12)}`
        );
        (result.reused ? reused : imported).push(result.view);
      } catch (error) {
        failed.push({ file: path.basename(source), message: error.message });
      }
    }

    if (imported.length) await writeCatalog(catalog, current);
    return { imported, reused, failed };
  }

  /**
   * 导入内存中的图片（例如从剪贴板粘贴）。
   * 渲染层拿不到剪贴板图片的文件路径，所以走 base64 传输：
   * items: [{ name, ext, base64 }]
   */
  async function importBuffers(projectId, items) {
    const { assets, catalog } = dirs(projectId);
    await fsp.mkdir(assets, { recursive: true });
    const current = readCatalog(catalog);
    const imported = [];
    const reused = [];
    const failed = [];

    for (const item of items || []) {
      const label = text(item?.name, 120) || "粘贴图片";
      try {
        const ext = text(item?.ext, 8).toLowerCase();
        if (!IMAGE_EXT.has(ext)) throw new Error(`不支持的图片格式 ${ext || "(无扩展名)"}`);
        const buffer = Buffer.from(String(item?.base64 || ""), "base64");
        if (!buffer.length) throw new Error("图片内容为空");
        if (buffer.length > MAX_BYTES) throw new Error(`超过 ${MAX_BYTES / 1024 / 1024}MB 上限`);
        const result = await commitBuffer(projectId, current, buffer, ext, label);
        (result.reused ? reused : imported).push(result.view);
      } catch (error) {
        failed.push({ file: label, message: error.message });
      }
    }

    if (imported.length) await writeCatalog(catalog, current);
    return { imported, reused, failed };
  }

  async function rename(projectId, assetId, name) {
    const { catalog } = dirs(projectId);
    const current = readCatalog(catalog);
    const asset = current.assets.find((a) => a.id === assetId);
    if (!asset) throw new Error("素材不存在");
    // 只改展示名；assetId 与分镜引用保持不变
    asset.name = text(name, 120) || asset.name;
    await writeCatalog(catalog, current);
    return publicView(asset);
  }

  async function thumbDataUrl(projectId, assetId) {
    if (thumbCache.has(assetId)) return thumbCache.get(assetId);
    const asset = await findAsset(projectId, assetId);
    if (!asset) return "";
    const { thumbs: thumbDir } = dirs(projectId);
    if (!asset.hasThumb) return "";
    try {
      const buffer = await fsp.readFile(safePath(thumbDir, `${asset.id}.png`));
      const url = `data:image/png;base64,${buffer.toString("base64")}`;
      thumbCache.set(assetId, url);
      return url;
    } catch {
      return "";
    }
  }

  async function previewDataUrl(projectId, assetId) {
    const asset = await findAsset(projectId, assetId);
    if (!asset) return "";
    const { assets } = dirs(projectId);
    try {
      const buffer = await fsp.readFile(safePath(assets, asset.fileName));
      return `data:${MIME[asset.ext] || "application/octet-stream"};base64,${buffer.toString("base64")}`;
    } catch {
      return "";
    }
  }

  /** 删除素材文件与目录记录（引用检查由 service 负责，此处只做删除） */
  async function remove(projectId, assetIds) {
    const ids = new Set((assetIds || []).map(String));
    const { assets: assetsDir, thumbs: thumbsDir, catalog } = dirs(projectId);
    const current = readCatalog(catalog);
    const removed = [];
    const kept = [];
    for (const asset of current.assets) {
      if (!ids.has(asset.id)) {
        kept.push(asset);
        continue;
      }
      removed.push(publicView(asset));
      for (const [dir, fileName] of [
        [assetsDir, asset.fileName],
        [thumbsDir, `${asset.id}.png`],
      ]) {
        try {
          await fsp.unlink(safePath(dir, fileName));
        } catch {}
      }
      thumbCache.delete(asset.id);
    }
    current.assets = kept;
    await writeCatalog(catalog, current);
    return removed;
  }

  return {
    IMAGE_EXT,
    findAsset,
    importBuffers,
    importPaths,
    list,
    previewDataUrl,
    remove,
    rename,
    thumbDataUrl,
  };
}

module.exports = { IMAGE_EXT, MAX_BYTES, createAssets };