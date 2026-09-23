"use strict";
/**
 * 结果下载
 *
 * 关键约束：
 * - 下载状态与生成状态完全独立：下载失败只改 download 字段，
 *   绝不把生成结果判定为失败，也绝不因此重新生成。
 * - 文件命名包含「项目 + 分镜编号 + 尝试编号」，避免覆盖历史结果。
 * - 传输函数由外部注入，便于离线测试；Electron 实现对账号会话 Cookie 与 Referer 的处理
 *   在 workbench-dola-driver.js 中，与既有高清原片下载保持一致（沿用账号会话）。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { DOWNLOAD_STATUS, setDownload } = require("./workbench-task-store");

const EXT_BY_MIME = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
};

/** 去掉文件名非法字符，并限制长度，避免超长路径 */
function sanitizeSegment(value, fallback = "未命名") {
  const cleaned = String(value ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}

function extensionFor(url, mime) {
  const known = EXT_BY_MIME[String(mime || "").toLowerCase()];
  if (known) return known;
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.(mp4|webm|mov|mkv)$/.test(ext)) return ext;
  } catch {}
  return ".mp4";
}

/** 项目_分镜03_尝试02.mp4 */
function buildFileName({ projectName, storyboardIndex, attemptNumber, url, mime }) {
  const project = sanitizeSegment(projectName, "项目");
  const index = String(Math.max(1, Number(storyboardIndex) || 1)).padStart(2, "0");
  const attempt = String(Math.max(1, Number(attemptNumber) || 1)).padStart(2, "0");
  return `${project}_分镜${index}_尝试${attempt}${extensionFor(url, mime)}`;
}

/** 同名时追加 (2)(3)…，绝不覆盖已有文件 */
async function uniquePath(dir, fileName) {
  const base = path.basename(fileName, path.extname(fileName));
  const ext = path.extname(fileName);
  let candidate = path.join(dir, fileName);
  for (let i = 2; fs.existsSync(candidate) && i < 500; i++) {
    candidate = path.join(dir, `${base}(${i})${ext}`);
  }
  return candidate;
}

/**
 * fetchToFile({url, filePath, accountId}) -> {ok, bytes, mime, error}
 * 由注入实现负责携带账号会话。
 */
function createDownloader({ taskStore, outputDirFor, fetchToFile }) {
  async function download({ projectId, attemptId, projectName, storyboardIndex }) {
    const tasks = await taskStore.list(projectId);
    const record = tasks.find((t) => t.id === attemptId);
    if (!record) throw new Error("任务记录不存在");
    if (record.status !== "succeeded" || !record.result?.videoUrl) {
      throw new Error("只有生成成功且有结果地址的任务才能下载");
    }

    const dir = await outputDirFor(projectId);
    await fsp.mkdir(dir, { recursive: true });
    const fileName = buildFileName({
      projectName,
      storyboardIndex,
      attemptNumber: record.attempt,
      url: record.result.videoUrl,
    });
    const filePath = await uniquePath(dir, fileName);

    await taskStore.update(projectId, attemptId, (r) => setDownload(r, DOWNLOAD_STATUS.RUNNING));

    try {
      const result = await fetchToFile({
        url: record.result.videoUrl,
        filePath,
        accountId: record.accountId,
      });
      if (!result?.ok) throw new Error(result?.error || "下载失败");

      // 最终扩展名以响应类型为准；若与预期不同则改名
      const finalPath =
        result.mime && extensionFor(record.result.videoUrl, result.mime) !== path.extname(filePath)
          ? await uniquePath(dir, path.basename(filePath, path.extname(filePath)) + extensionFor(record.result.videoUrl, result.mime))
          : filePath;
      if (finalPath !== filePath) {
        await fsp.rename(filePath, finalPath);
      }

      const updated = await taskStore.update(projectId, attemptId, (r) => {
        setDownload(r, DOWNLOAD_STATUS.DONE, { filePath: finalPath, message: "" });
        return r;
      });
      return { ok: true, filePath: finalPath, bytes: result.bytes || 0, record: updated };
    } catch (error) {
      // 仅记录下载失败；status / error / finishedAt 一律不动
      const updated = await taskStore.update(projectId, attemptId, (r) => {
        setDownload(r, DOWNLOAD_STATUS.FAILED, { message: error?.message || String(error) });
        return r;
      });
      return { ok: false, error: error?.message || String(error), record: updated };
    }
  }

  return { download };
}

module.exports = { buildFileName, createDownloader, extensionFor, sanitizeSegment, uniquePath };