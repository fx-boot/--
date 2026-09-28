"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

function createProjectAssets({ store, assets }) {
  async function family(projectId) {
    const project = await store.readProject(projectId);
    if (!project) throw new Error("项目不存在");
    const rootId = project.parentId || project.id;
    const index = await store.readIndex();
    return index.projects.filter(item => item.id === rootId || item.parentId === rootId);
  }

  async function reuse(targetId, sourceId, assetIds) {
    const folders = await family(targetId);
    if (!folders.some(item => item.id === sourceId)) throw new Error("只能复用同一大项目内的素材");
    if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > 100) throw new Error("请选择 1 至 100 张素材");
    const imported = [], reused = [], failed = [];
    for (const assetId of new Set(assetIds)) {
      let asset;
      try {
        asset = await assets.findAsset(sourceId, assetId);
        if (!asset) throw new Error("来源素材不存在");
        const directory = path.resolve(store.assetsDir(sourceId));
        const file = path.resolve(directory, asset.fileName);
        if (!file.startsWith(directory + path.sep)) throw new Error("来源素材路径无效");
        const bytes = await fs.readFile(file);
        if (crypto.createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("来源素材已变化，请重新导入");
        const result = await assets.importBuffers(targetId, [{ name: asset.name, ext: asset.ext, base64: bytes.toString("base64") }]);
        imported.push(...result.imported); reused.push(...result.reused); failed.push(...result.failed);
      } catch (error) { failed.push({ file: asset?.name || String(assetId), message: error.message }); }
    }
    return { imported, reused, failed };
  }
  return { family, reuse };
}
module.exports = { createProjectAssets };
