"use strict";
/**
 * 结果下载（生成状态与下载状态完全独立）
 *
 * 关键约束：
 * - 下载状态与生成状态完全独立：下载失败只改 download 字段，
 *   绝不把生成结果判定为失败，也绝不因此重新生成。
 * - 下载阶段显式化：解析源 → 下载中 → 校验中 → 完成 / 失败 / 暂停 / 已取消。
 * - 多来源并存：澜川同源（平台原片）优先，失败可回退平台播放版；回退只发生在下载环节。
 * - 断点续传：暂停/失败保留 .part，重试时带 Range 续传（服务端忽略 Range 时自动从头写）。
 * - 完整性校验：落盘后用 ffprobe 校验，损坏则标记失败（不是「生成失败」）。
 * - 文件命名：项目_分镜NN_账号_来源标识_v尝试.mp4（来源标识区分澜川同源/平台播放版）。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { DOWNLOAD_STATUS, setDownload } = require("./workbench-task-store");
const sources = require("./workbench-sources");
const { errorCode, describe } = require("./hd-transfer");
const { commitPart, fetchToPart, existingPartSize, partPathFor, removePart } = require("./workbench-transfer");

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

/**
 * 项目_分镜03_Dola004_澜川同源_v2.mp4
 * 来源标识：澜川同源（无水印原片）/ 平台播放版（普通下载）
 */
function buildFileName({ projectName, storyboardIndex, attemptNumber, url, mime, accountName, sourceTag }) {
  const project = sanitizeSegment(projectName, "项目");
  const index = String(Math.max(1, Number(storyboardIndex) || 1)).padStart(2, "0");
  const attempt = String(Math.max(1, Number(attemptNumber) || 1)).padStart(2, "0");
  const account = sanitizeSegment(accountName || "", "").replace(/\s/g, "") || "账号";
  const tag = sanitizeSegment(sourceTag || "", "").replace(/\s/g, "") || "下载";
  return `${project}_分镜${index}_${account}_${tag}_v${attempt}${extensionFor(url, mime)}`;
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

/** 进度速率/剩余时间：用最近若干次回调的时间窗口算，避免整体平均值失真 */
function createRateMeter() {
  const samples = [];
  return (received, total) => {
    const at = Date.now();
    samples.push({ at, received });
    while (samples.length > 2 && at - samples[0].at > 6000) samples.shift();
    const first = samples[0];
    const span = at - first.at;
    const bytes = received - first.received;
    const speed = span > 400 && bytes > 0 ? bytes / (span / 1000) : 0;
    const remaining = speed > 0 && total > received ? (total - received) / speed : 0;
    return { speed, remaining };
  };
}

/**
 * createDownloader：任务下载编排。
 * 依赖注入（便于离线测试）：
 *   taskStore / outputDirFor / sessionFor / groupsForAccount / scanAccount / probe / parser / onProgress
 */
function createDownloader({
  taskStore,
  outputDirFor,
  sessionFor,
  groupsForAccount = () => [],
  scanAccount = async () => ({ scanned: 0 }),
  probe = null,
  parser = null,
  onProgress = () => {},
  now = () => Date.now(),
  // 注入点（离线测试用）：默认走真实实现，测试里换成桩
  transfer = fetchToPart,
  resolveFallback = resolveOriginalUrl,
}) {
  /** 正在进行的下载：attemptId → { controller, jobId } */
  const running = new Map();
  /** 暂停中的下载：保留原因，便于界面显示 */
  const paused = new Map();

  async function requireRecord(projectId, attemptId) {
    const tasks = await taskStore.list(projectId);
    const record = tasks.find((t) => t.id === attemptId);
    if (!record) throw new Error("任务记录不存在");
    return { record, tasks };
  }

  /** 解析可用下载源（不下载）：同源 + 播放版，附不可用原因 */
  async function resolveSources({ projectId, attemptId, refresh = false }) {
    const { record } = await requireRecord(projectId, attemptId);
    if (!record.result?.videoUrl) {
      return {
        sources: [],
        note: "本次任务还没有可用的结果地址（生成未成功或平台未返回结果）",
        matchedBy: "none",
      };
    }
    if (refresh) await scanAccount(record.accountId).catch(() => {});
    const groups = groupsForAccount(record.accountId) || [];
    const result = sources.buildSources({ videoUrl: record.result.videoUrl, groups, parser });
    return result;
  }

  function progressReporter(projectId, attemptId, sourceMeta) {
    const meter = createRateMeter();
    let lastPush = 0;
    return (patch = {}) => {
      const at = now();
      if (patch.received !== undefined) {
        const { speed, remaining } = meter(Number(patch.received) || 0, Number(patch.total) || 0);
        patch.speed = speed;
        patch.remaining = remaining;
      }
      // 进度写库不必每次都刷（界面另有实时通道），但节流后必须保证最后一次落库
      const urgent = patch.force || at - lastPush > 1500;
      if (urgent) lastPush = at;
      onProgress({ projectId, attemptId, source: sourceMeta, at: new Date(at).toISOString(), ...patch });
      return urgent;
    };
  }

  /**
   * 下载：sourceId 省略时自动选择（澜川同源优先）。
   * options.resume=true 时优先续传已有 .part。
   */
  async function download({
    projectId,
    attemptId,
    projectName,
    storyboardIndex,
    accountName = "",
    sourceId = "",
    resume = false,
    allowFallback = true,
  }) {
    const { record } = await requireRecord(projectId, attemptId);
    if (record.status !== "succeeded" || !record.result?.videoUrl) {
      throw new Error("只有生成成功且有结果地址的任务才能下载");
    }
    if (running.has(attemptId)) {
      return { ok: false, error: "该任务正在下载中", errorCode: "ALREADY_RUNNING" };
    }

    const controller = new AbortController();
    running.set(attemptId, { controller });
    const startedAt = now();
    let partPath = "";
    /** 最终去向：done / paused / canceled / failed —— 决定分片是否保留 */
    let optionOutcome = "failed";

    const resolved = await resolveSources({ projectId, attemptId, refresh: true });
    const chosenId = sourceId || sources.defaultSourceId(resolved.sources);
    let current = resolved.sources.find((s) => s.id === chosenId) || null;
    if (!current || !current.available) {
      const reason = current?.error || "没有可用的下载来源";
      const hint = current?.errorHint || "";
      const updated = await taskStore.update(projectId, attemptId, (r) => {
        setDownload(r, DOWNLOAD_STATUS.FAILED, {
          source: current?.kind || "",
          sourceLabel: current?.label || "",
          errorCode: "SOURCE_UNAVAILABLE",
          message: reason,
          hint,
        });
        return r;
      });
      running.delete(attemptId);
      return { ok: false, error: reason, errorCode: "SOURCE_UNAVAILABLE", hint, record: updated };
    }

    const dir = await outputDirFor(projectId);
    await fsp.mkdir(dir, { recursive: true });
    partPath = partPathFor(path.join(dir, ".dbm-dl-" + attemptId));

    const report = progressReporter(projectId, attemptId, { id: current.id, kind: current.kind, tag: current.tag });

    const resumedBytes = resume ? await existingPartSize(partPath).catch(() => 0) : 0;
    const started = await taskStore.update(projectId, attemptId, (r) => {
      setDownload(r, DOWNLOAD_STATUS.RUNNING, {
        source: current.kind,
        sourceLabel: current.label,
        url: current.requiresResolve ? "" : current.url,
        urlSafe: current.urlSafe,
        bytes: resumedBytes,
        resumed: resumedBytes > 0,
        startedAt: new Date(startedAt).toISOString(),
        elapsedMs: 0,
        message: current.requiresResolve ? "正在解析澜川同源原片地址…" : "正在下载…",
      });
      return r;
    });
    report({ phase: "start", received: resumedBytes, total: 0, force: true, resumed: resumedBytes > 0, message: started.download.message });

    const session = sessionFor(record.accountId);
    const headers = { Referer: "https://www.dola.com/", Accept: "video/*,application/octet-stream;q=0.9,*/*;q=0.8" };

    /** 单来源下载（解析同源地址 → 传输 → 校验 → 落盘） */
    const runSource = async (source) => {
      let url = source.url;
      if (source.requiresResolve) {
        report({ phase: "resolve", force: true, message: "正在解析澜川同源原片地址…" });
        url = await resolveFallback(source.fallbackApi, session, headers, controller.signal);
        await taskStore.update(projectId, attemptId, (r) => {
          setDownload(r, DOWNLOAD_STATUS.RUNNING, { url, message: "原片地址已解析，开始下载…" });
          return r;
        });
      }
      const transferred = await transfer({
        session,
        url,
        headers,
        partPath,
        resume,
        signal: controller.signal,
        onProgress: (p) => report({ phase: "download", received: p.received, total: p.total, resumed: p.resumed }),
      });
      report({ phase: "verify", received: transferred.received, total: transferred.total, force: true, message: "下载完成，正在校验文件完整性…" });
      await taskStore.update(projectId, attemptId, (r) => {
        setDownload(r, DOWNLOAD_STATUS.RUNNING, { bytes: transferred.received, expectedBytes: transferred.total, resumed: transferred.resumed });
        return r;
      });
      return { url, transferred };
    };

    try {
      let outcome = null;
      let lastError = null;
      for (const candidate of [current, ...(allowFallback ? resolved.sources.filter((s) => s.id !== current.id && s.available) : [])]) {
        try {
          outcome = await runSource(candidate);
          current = candidate;
          break;
        } catch (error) {
          lastError = error;
          const code = errorCode(error);
          if (controller.signal.aborted) throw error;
          const canFallback = allowFallback && candidate.requiresResolve && sources.shouldFallbackToPlayback(code);
          report({ phase: "fallback", force: true, message: canFallback ? `澜川同源失败（${code}），改用平台播放版重试` : describe(error), errorCode: code });
          await taskStore.update(projectId, attemptId, (r) => {
            setDownload(r, DOWNLOAD_STATUS.RUNNING, {
              message: canFallback ? `澜川同源不可用（${code}），已回退平台播放版` : describe(error),
              errorCode: code,
            });
            return r;
          });
          if (!canFallback) throw error;
        }
      }
      if (!outcome) throw lastError || new Error("下载失败");

      const { url, transferred } = outcome;
      const probeResult = probe ? await probe.inspect(partPath).catch(() => null) : null;
      if (probe && probeResult && (probeResult.status !== "ready" || !probeResult.width || !probeResult.height)) {
        throw Object.assign(new Error(probeResult.message || "文件已下载但无法解析出视频轨道，判定为损坏"), { code: "FILE_CORRUPT" });
      }

      const fileName = buildFileName({
        projectName,
        storyboardIndex,
        attemptNumber: record.attempt,
        url,
        accountName,
        sourceTag: current.tag,
      });
      const filePath = await uniquePath(dir, fileName);
      await commitPart(partPath, filePath);
      partPath = "";

      const finishedAt = now();
      const updated = await taskStore.update(projectId, attemptId, (r) => {
        setDownload(r, DOWNLOAD_STATUS.DONE, {
          source: current.kind,
          sourceLabel: current.label,
          url,
          urlSafe: current.urlSafe || sources.redactUrl(url),
          filePath,
          bytes: transferred.received,
          expectedBytes: transferred.total,
          resumed: transferred.resumed,
          elapsedMs: finishedAt - startedAt,
          errorCode: "",
          message: "",
        });
        if (r.result) {
          r.result = { ...r.result, filePath, width: probeResult?.width || r.result.width, height: probeResult?.height || r.result.height, durationSeconds: probeResult?.duration || r.result.durationSeconds };
        }
        return r;
      });
      report({ phase: "done", received: transferred.received, total: transferred.total, force: true, filePath, message: "下载完成" });
      optionOutcome = "done";
      return { ok: true, filePath, bytes: transferred.received, source: current.kind, record: updated };
    } catch (error) {
      const code = errorCode(error);
      if (code === "ABORT_ERR" && paused.has(attemptId)) {
        const kept = await existingPartSize(partPath).catch(() => 0);
        const updated = await taskStore.update(projectId, attemptId, (r) => {
          setDownload(r, DOWNLOAD_STATUS.PAUSED, { bytes: kept, resumed: kept > 0, message: "已暂停，可继续下载（支持断点续传）", errorCode: "" });
          return r;
        });
        report({ phase: "paused", received: kept, force: true, message: "已暂停" });
        optionOutcome = "paused";
        return { ok: false, paused: true, record: updated };
      }
      if (code === "ABORT_ERR") {
        await removePart(partPath).catch(() => {});
        const updated = await taskStore.update(projectId, attemptId, (r) => {
          setDownload(r, DOWNLOAD_STATUS.FAILED, { message: "已取消下载", errorCode: "CANCELED" });
          return r;
        });
        report({ phase: "canceled", force: true, message: "已取消" });
        optionOutcome = "canceled";
        return { ok: false, canceled: true, record: updated };
      }
      const hint = describe(error);
      const updated = await taskStore.update(projectId, attemptId, (r) => {
        setDownload(r, DOWNLOAD_STATUS.FAILED, { message: hint, errorCode: code, hint });
        return r;
      });
      report({ phase: "failed", force: true, message: hint, errorCode: code });
      return { ok: false, error: hint, errorCode: code, record: updated };
    } finally {
      running.delete(attemptId);
      paused.delete(attemptId);
      // 分片保留规则：完成时 part 已改名（partPath 置空）；暂停/失败保留（可续传）；取消已单独删除
      if (partPath && optionOutcome === "canceled") await removePart(partPath).catch(() => {});
    }
  }

  /** 暂停：保留 .part，可续传 */
  async function pause(projectId, attemptId) {
    const item = running.get(attemptId);
    if (!item) return { ok: false, reason: "该任务没有正在进行的下载" };
    paused.set(attemptId, true);
    item.controller.abort();
    return { ok: true };
  }

  /** 取消：删除分片 */
  async function cancel(projectId, attemptId) {
    const item = running.get(attemptId);
    if (!item) return { ok: false, reason: "该任务没有正在进行的下载" };
    paused.delete(attemptId);
    item.controller.abort();
    return { ok: true };
  }

  /** 是否可续传（存在分片） */
  async function resumable(projectId, attemptId) {
    const dir = await outputDirFor(projectId);
    const partPath = partPathFor(path.join(dir, ".dbm-dl-" + attemptId));
    const size = await existingPartSize(partPath);
    return { resumable: size > 0, bytes: size };
  }

  return { download, pause, cancel, resumable, resolveSources, running };
}

/** 同源解析实现（延迟 require，避免离线测试时加载 electron） */
async function resolveOriginalUrl(fallbackApi, session, headers, signal) {
  const { resolveOriginal } = require("./hd-original-request");
  return resolveOriginal({ session, fallbackApi, headers, signal });
}

module.exports = {
  buildFileName,
  createDownloader,
  createRateMeter,
  extensionFor,
  sanitizeSegment,
  uniquePath,
};