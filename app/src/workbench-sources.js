"use strict";
/**
 * 下载源解析（纯逻辑，无 Electron 依赖，可离线测试）
 *
 * 两种来源并存：
 * - 澜川同源（lanchuan-original）：复用应用既有的原片链路 —— 页面观察器抓到的
 *   fallback_api（byteintlapi.com/video/fplay）经 dola-original-resolver 解出无水印原片地址；
 * - 平台播放版（platform-playback）：生成结果里直接可用的播放地址（普通下载）。
 *
 * 硬约束：
 * - 解析失败不影响「生成成功」的判定，只把该来源标成不可用并给出原因；
 * - 不做「猜」：只有能证明与本次结果视频是同一个视频（播放地址精确命中或同路径命中）时，
 *   才提供澜川同源来源；否则明确写「无法确认是同一个视频」，不做时间上的将就；
 * - 对外暴露的地址一律用脱敏形式（去掉查询串），完整地址只作为内部请求参数。
 */

const KIND = Object.freeze({
  LANCHUAN: "lanchuan-original",
  PLAYBACK: "platform-playback",
});

const SOURCE_META = Object.freeze({
  [KIND.LANCHUAN]: { tag: "澜川同源", label: "澜川同源（平台原片·无水印）", requiresResolve: true },
  [KIND.PLAYBACK]: { tag: "平台播放版", label: "普通下载（平台播放版）", requiresResolve: false },
});

/** 脱敏：只留 origin + path，鉴权参数不进界面与日志 */
function redactUrl(value) {
  try {
    const url = new URL(String(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

/** 比对用归一化：忽略查询串（签名每次都不同），只比 host + path */
function normalizeForMatch(value) {
  try {
    const url = new URL(String(value));
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

/**
 * 把本次结果视频与页面观察器抓到的分组对应起来。
 * matchedBy: exact（完整地址一致）/ path（同 host+path，签名不同）/ none
 */
function pickGroupForVideo({ groups = [], videoUrl = "" }) {
  const wanted = String(videoUrl || "");
  const wantedKey = normalizeForMatch(wanted);
  if (!wantedKey) return { matchedBy: "none", group: null };
  const candidates = (Array.isArray(groups) ? groups : []).filter((g) => g && Array.isArray(g.variants));
  for (const group of candidates) {
    if (group.variants.some((v) => String(v?.url || "") === wanted)) return { matchedBy: "exact", group };
  }
  for (const group of candidates) {
    if (group.variants.some((v) => normalizeForMatch(v?.url) === wantedKey)) return { matchedBy: "path", group };
  }
  return { matchedBy: "none", group: null };
}

/**
 * 生成可选下载源清单。
 * 入参：videoUrl（本次结果播放地址）、groups（该账号观察到的视频分组，含 fallbackApi）、
 *       parser（hd-candidates 的 createParser()，用于合法性校验）。
 * 返回：sources 按「澜川同源优先」排序，每一项都带 available 与不可用原因。
 */
function buildSources({ videoUrl = "", groups = [], parser = null } = {}) {
  const sources = [];
  const validateUrl = (value) => (parser?.url ? parser.url(value) : String(value || ""));
  const validateFallback = (value) => (parser?.fallback ? parser.fallback(value) : /^https:\/\/[^/]*byteintlapi\.com\/video\/fplay/i.test(String(value || "")) ? String(value) : "");

  const playbackUrl = validateUrl(videoUrl);
  const { matchedBy, group } = pickGroupForVideo({ groups, videoUrl });
  const fallbackApi = matchedBy === "none" ? "" : validateFallback(group?.fallbackApi || "");

  sources.push({
    id: "lanchuan",
    kind: KIND.LANCHUAN,
    ...SOURCE_META[KIND.LANCHUAN],
    available: Boolean(fallbackApi),
    fallbackApi: fallbackApi || "",
    urlSafe: playbackUrl ? `${redactUrl(playbackUrl)}（原片地址解析后生成）` : "",
    matchedBy,
    error: fallbackApi
      ? ""
      : matchedBy === "none"
        ? "未能把本次结果与平台原片接口对应上，无法确认是同一个视频"
        : "该视频没有可用的平台原片接口地址",
    errorHint: fallbackApi ? "" : "先在该账号页面打开生成结果并重新扫描，再重试下载",
  });
  sources.push({
    id: "playback",
    kind: KIND.PLAYBACK,
    ...SOURCE_META[KIND.PLAYBACK],
    available: Boolean(playbackUrl),
    url: playbackUrl,
    urlSafe: redactUrl(playbackUrl),
    error: playbackUrl ? "" : "本次结果里没有可用的播放地址",
    errorHint: playbackUrl ? "" : "等待平台返回结果地址后重试，或直接在平台页面下载",
  });

  const note = fallbackApi
    ? "澜川同源优先：先解出无水印原片地址，失败时可回退到平台播放版"
    : "本次只提供平台播放版（澜川同源不可用，原因见来源说明）";
  return { sources, note, matchedBy };
}

/** 取默认下载源：同源可用就用同源，否则回落播放版 */
function defaultSourceId(sources = []) {
  const available = sources.filter((s) => s.available);
  return available.find((s) => s.kind === KIND.LANCHUAN)?.id || available[0]?.id || "";
}

/** 同源失败后是否值得回退到播放版（链接类问题都值得回退） */
function shouldFallbackToPlayback(errorCode = "") {
  return /ORIGINAL_|HTTP_(401|403|404|410|416)|NOT_VIDEO/.test(String(errorCode || ""));
}

module.exports = {
  KIND,
  SOURCE_META,
  buildSources,
  defaultSourceId,
  normalizeForMatch,
  pickGroupForVideo,
  redactUrl,
  shouldFallbackToPlayback,
};