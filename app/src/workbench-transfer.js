"use strict";
/**
 * 工作台下载传输层：在既有 hd-transfer 语义之上补齐「断点续传 / 暂停 / 进度」。
 *
 * 复用而不是另造一套：
 * - 错误码、错误文案、可重试判定全部复用 hd-transfer（errorCode/describe/retryable/failure/requestHeaders），
 *   保证「澜川同源下载」与既有高清原片下载口径一致；
 * - HD 自身链路仍走 hd-transfer.downloadStream，本模块不改动它，只服务工作台任务下载。
 *
 * 断点续传语义（实测口径，不臆断服务器能力）：
 * - 有 .part 文件时带 Range: bytes=<n>- 请求；
 * - 服务端返回 206 且 Content-Range 的起始/总长与本地一致 → 追加写；
 * - 服务端忽略 Range 返回 200 → 从头写（截断），避免两个版本拼接；
 * - 两者都对不上（例如 416）→ 报明确错误，由上层决定是否重来。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { errorCode, failure, requestHeaders } = require("./hd-transfer");

const PART_SUFFIX = ".part";

const partPathFor = (filePath) => `${filePath}${PART_SUFFIX}`;

/** 已有分片长度（没有就是 0） */
async function existingPartSize(partPath) {
  try {
    const stat = await fsp.stat(partPath);
    return stat.isFile() && stat.size > 0 ? stat.size : 0;
  } catch {
    return 0;
  }
}

async function removePart(partPath) {
  await fsp.rm(partPath, { force: true }).catch(() => {});
}

/**
 * 单次传输尝试。返回 {received, total, resumed, restarted}。
 * signal.abort() 时抛 code=ABORT_ERR（由调用方决定是「暂停」还是「取消」）。
 */
function transferOnce({
  session,
  url,
  headers,
  partPath,
  resumeFrom = 0,
  signal,
  onProgress = () => {},
  idleMs = 90000,
  requestFactory,
}) {
  return new Promise((resolve, reject) => {
    let request;
    let response;
    let timer;
    let streamDone;
    let settled = false;
    let received = resumeFrom;
    let total = 0;
    const stop = new AbortController();

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        stop.abort();
        request?.abort();
        response?.destroy?.();
        if (streamDone) void streamDone.catch(() => {}).then(() => reject(error));
        else reject(error);
      } else {
        resolve(value);
      }
    };
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(failure("IDLE_TIMEOUT")), idleMs);
      timer.unref?.();
    };
    const abort = () => finish(failure("ABORT_ERR"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });

    try {
      // 与既有实现一致：账号会话 + Chromium 代理 + Cookie 存储，不手工拼 Cookie
      request = (requestFactory || require("electron").net.request)({
        method: "GET",
        url,
        session,
        credentials: "include",
        redirect: "follow",
        referrerPolicy: "strict-origin-when-cross-origin",
        headers: {
          ...requestHeaders(url, headers),
          "Accept-Encoding": "identity",
          ...(resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {}),
        },
      });
      request.on("error", (error) => finish(error));
      request.on("abort", () => {
        if (!settled) finish(failure("ABORT_ERR"));
      });
      request.on("response", async (incoming) => {
        response = incoming;
        const header = (name) => {
          const value = incoming.headers[name];
          return Array.isArray(value) ? value[0] : String(value || "");
        };
        if (incoming.statusCode < 200 || incoming.statusCode >= 300) {
          const code = `HTTP_${incoming.statusCode}`;
          // 416：请求的续传位置超出服务端资源长度（多半是文件被换过）
          return finish(failure(code, incoming.statusCode === 416 ? "断点位置已超出文件长度，请重新下载" : undefined));
        }
        if (/text\/|json|mpegurl|dash\+xml/i.test(header("content-type"))) {
          return finish(failure("NOT_VIDEO"));
        }

        let truncated = false;
        let resumed = false;
        const contentRange = header("content-range");
        if (resumeFrom > 0 && incoming.statusCode === 206) {
          const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(contentRange).trim());
          if (!match || Number(match[1]) !== resumeFrom) {
            return finish(failure("PARTIAL_CONTENT", "服务端返回的分片范围与本地不一致，请重新下载"));
          }
          total = Number(match[3]) || 0;
          resumed = true;
        } else if (resumeFrom > 0) {
          // 服务端忽略 Range：从头写，避免拼接出坏文件
          truncated = true;
        }
        if (!resumed) {
          received = 0;
          total = Number(header("content-length")) || 0;
        }
        onProgress({ received, total, resumed, restarted: truncated });
        touch();

        const count = new Transform({
          transform(chunk, _encoding, done) {
            received += chunk.length;
            touch();
            onProgress({ received, total, resumed });
            done(null, chunk);
          },
        });
        try {
          streamDone = pipeline(
            incoming,
            count,
            fs.createWriteStream(partPath, { flags: truncated || !resumed ? "w" : "a" }),
            { signal: stop.signal }
          );
          await streamDone;
          const written = received - (resumed ? resumeFrom : 0);
          if (!written) throw failure("EMPTY_VIDEO");
          if (total && (!header("content-encoding") || header("content-encoding") === "identity") && received !== total) {
            throw failure("INCOMPLETE_VIDEO");
          }
          finish(null, { received, total, resumed, restarted: truncated });
        } catch (error) {
          finish(error);
        }
      });
      touch();
      request.end();
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * 完整的「一次下载」= 同源地址解析（可选）→ 传输（可续传）→ 立即改名成最终文件。
 * 这里只负责把文件落成 .part 再原子改名；完整性校验（ffprobe）由调用方做，
 * 因为「传输完成」与「文件可用」是两件事。
 */
async function fetchToPart({
  session,
  url,
  headers,
  partPath,
  resume = false,
  signal,
  onProgress,
  requestFactory,
  attempts = 2,
}) {
  const resumeFrom = resume ? await existingPartSize(partPath) : 0;
  if (!resume) await removePart(partPath);
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      const result = await transferOnce({
        session,
        url,
        headers,
        partPath,
        resumeFrom: attempt === 1 ? resumeFrom : await existingPartSize(partPath),
        signal,
        onProgress,
        requestFactory,
      });
      return { ...result, attempt };
    } catch (error) {
      lastError = error;
      const code = errorCode(error);
      // 分片保留规则：可续传的失败、以及「暂停」导致的中止都保留 .part；
      // 「取消」由调用方在结束时清理（调用方才知道是暂停还是取消）。
      const keepPartial =
        code === "ABORT_ERR" ||
        /ERR_(CONNECTION|TIMED_OUT|NETWORK)|ECONNRESET|ETIMEDOUT|IDLE_TIMEOUT|INCOMPLETE_VIDEO|PARTIAL_CONTENT|HTTP_50[234]/.test(code);
      if (!keepPartial) await removePart(partPath);
      if (signal?.aborted || attempt >= attempts || !keepPartial) break;
    }
  }
  throw lastError || failure("DOWNLOAD_FAILED");
}

/** .part → 最终文件（原子改名；同名文件由调用方先用 uniquePath 处理） */
async function commitPart(partPath, filePath) {
  await fsp.rm(filePath, { force: true }).catch(() => {});
  await fsp.rename(partPath, filePath);
  return filePath;
}

module.exports = {
  PART_SUFFIX,
  commitPart,
  existingPartSize,
  fetchToPart,
  partPathFor,
  removePart,
  transferOnce,
};