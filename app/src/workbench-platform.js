"use strict";
/**
 * 平台适配层（纯逻辑部分，不依赖 Electron，可离线测试）
 *
 * 只做三件事：
 *   1. 用平台真实能力表校验参数，不合规就拒绝提交（绝不提交不支持的参数）；
 *   2. 明确声明平台未提供的能力（显示为「未知」，不编造）；
 *   3. 把工作台的结构化图片引用转换成平台可执行的分段计划（保留位置与顺序）。
 *
 * 真正的页面驱动在 workbench-dola-driver.js；这里不碰网络与 DOM。
 *
 * 下面的选择器与字段名来自本项目内既有可读模块的实测代码，不是猜测：
 *   - 编辑器与原子节点：src/webview-preload.js（editors 选择器、\uFFFC 表示内联非文本节点）
 *   - 工具栏控件：data-input-engine-actionbar-control-key="video-model" / "video-duration"
 *   - 视频请求特征：ability_type === 17 且带 ability_param（src/webview-preload.js）
 *   - 执行引擎声明：src/video-capabilities.js（manager-chromium-webview / webcontents-debugger-ipc）
 */

const TOKEN_RE = /@图(\d{1,3})/g;

/** 平台未提供、因此界面必须显示「未知」的能力项 */
const UNKNOWN_CAPABILITIES = Object.freeze(["ratio", "maxReferenceImages", "quota"]);

/**
 * 比例候选值：平台能力表里没有 ratios，所以这里只提供行业常见值供用户选择，
 * 并明确标注「平台比例能力未核实」。绝不声称这些值一定被平台接受。
 */
const RATIO_OPTIONS = Object.freeze(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);

const DOLA_SELECTORS = Object.freeze({
  editor: 'textarea, [contenteditable="true"], [contenteditable="plaintext-only"]',
  modelControl:
    '[data-input-engine-actionbar-control-key="video-model"], [data-input-engine-actionbar-control-key="model"]',
  durationControl:
    '[data-input-engine-actionbar-control-key="video-duration"], [data-input-engine-actionbar-control-key="duration"]',
  // 同理：按键名推导，是否真的存在需要实机探测，探测不到就如实回报
  ratioControl:
    '[data-input-engine-actionbar-control-key="video-ratio"], [data-input-engine-actionbar-control-key="ratio"], [data-input-engine-actionbar-control-key="video-aspect"]',
  actionbar: '[data-input-engine-actionbar], [class*="actionbar"], [class*="action-bar"]',
  atomicMark: "\uFFFC",
  fileInput: 'input[type="file"]',
});

const text = (value, max = 0) => {
  const out = String(value ?? "");
  return max > 0 ? out.slice(0, max) : out;
};

/**
 * 结构化引用 → 分段计划
 * 保证「图片标签的位置与顺序」被带到提交阶段：token 出现在文本哪里，
 * 图片就插到哪里，而不是统一堆到末尾。
 */
function buildSegments(prompt, refs, assetsById = new Map()) {
  const source = text(prompt);
  const byToken = new Map((refs || []).map((r) => [r.token, r]));
  const segments = [];
  let last = 0;
  let match;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(source))) {
    const ref = byToken.get(match[0]);
    if (!ref) continue;
    if (match.index > last) segments.push({ kind: "text", value: source.slice(last, match.index) });
    const asset = assetsById.get(ref.assetId) || null;
    segments.push({
      kind: "image",
      assetId: ref.assetId,
      token: ref.token,
      name: text(asset?.name ?? ref.name, 120),
      filePath: text(asset?.filePath),
      sha256: text(asset?.sha256 ?? ref.sha256, 64),
      width: Number(asset?.width) || 0,
      height: Number(asset?.height) || 0,
    });
    last = match.index + match[0].length;
  }
  if (last < source.length) segments.push({ kind: "text", value: source.slice(last) });
  return segments;
}

/** 提交给平台的纯文本：引用位置换成原子占位符，平台侧再替换为真实图片节点 */
function segmentsToPlainText(segments) {
  return (segments || [])
    .map((segment) => (segment.kind === "image" ? DOLA_SELECTORS.atomicMark : segment.value))
    .join("");
}

function describeCapabilities(capabilities, target = "dola") {
  const caps = capabilities?.targets?.[target] || null;
  const durations = (caps?.durations || []).map(String);
  return {
    target,
    name: caps?.name || target,
    models: caps?.models || [],
    durations,
    watermark: caps?.watermark || "",
    executionEngine: caps?.executionEngine || "",
    // true 表示平台能力表里没有该项 —— 界面必须显示「未知」，不得编造
    unknown: {
      ratio: !Array.isArray(caps?.ratios) || caps.ratios.length === 0,
      maxReferenceImages: !Number(caps?.maxReferenceImages),
      quota: true,
    },
  };
}

/**
 * 参数校验：只有全部通过才允许提交。
 * 平台不支持的模型/时长一律拒绝，不做静默降级。
 */
function validateParams({ target = "dola", params = {}, refs = [], capabilities = null } = {}) {
  const errors = [];
  const warnings = [];
  const caps = capabilities?.targets?.[target] || null;

  if (!caps) errors.push(`平台 ${target} 不在能力表中，拒绝提交`);

  const model = text(params.model);
  if (!model) errors.push("未选择模型");
  else if (caps && !(caps.models || []).includes(model)) {
    errors.push(`模型 ${model} 不在平台能力表中，拒绝提交`);
  }

  const duration = text(params.duration);
  if (!duration) errors.push("未选择时长");
  else if (caps && !(caps.durations || []).map(String).includes(duration)) {
    errors.push(`时长 ${duration} 不在平台能力表中，拒绝提交`);
  }

  if (!text(params.prompt).trim()) errors.push("提示词为空，拒绝提交");

  if (text(params.ratio) && (!caps || !Array.isArray(caps.ratios))) {
    warnings.push("平台未提供比例能力表，比例会尝试按页面控件设置，是否生效以平台实际结果为准");
  }

  const list = Array.isArray(refs) ? refs : [];
  if (list.length) {
    if (!caps || !Number(caps.maxReferenceImages)) {
      warnings.push(`平台未声明参考图数量上限，本次绑定 ${list.length} 张，是否被接受以平台实际结果为准`);
    } else if (list.length > Number(caps.maxReferenceImages)) {
      errors.push(`绑定 ${list.length} 张参考图，超过平台上限 ${caps.maxReferenceImages}`);
    }
    const missing = list.filter((ref) => !text(ref.filePath));
    if (missing.length) {
      errors.push(`${missing.length} 张参考图缺少本地文件，无法上传：${missing.map((r) => r.token).join("、")}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 生成执行计划（供驱动层逐步执行）。
 * 只描述「做什么」，不在这里做任何平台交互。
 */
function buildPlan({ target = "dola", attempt, assetsById = new Map(), capabilities = null } = {}) {
  const refs = attempt?.refs || [];
  const segments = buildSegments(attempt?.params?.prompt || "", refs, assetsById);
  const uploads = segments.filter((s) => s.kind === "image").map((s) => s.filePath);
  const validation = validateParams({
    target,
    params: attempt?.params || {},
    refs: segments.filter((s) => s.kind === "image").map((s) => ({ ...s, token: s.token })),
    capabilities,
  });

  const limitations = [];
  if (!uploads.length) limitations.push("本次没有绑定参考图片");
  else limitations.push(`参考图片以编辑器内联节点插入，位置与 @图片 标记一致（共 ${uploads.length} 张）`);
  if (validation.warnings.length) limitations.push(...validation.warnings);
  limitations.push("平台未提供生成进度百分比，只能按阶段与等待时长展示");

  return {
    target,
    valid: validation.ok,
    errors: validation.errors,
    warnings: validation.warnings,
    limitations,
    segments,
    uploads,
    params: {
      model: text(attempt?.params?.model),
      duration: text(attempt?.params?.duration),
      ratio: text(attempt?.params?.ratio),
      removeWatermark: attempt?.params?.removeWatermark !== false,
    },
    plainText: segmentsToPlainText(segments),
  };
}

module.exports = {
  DOLA_SELECTORS,
  RATIO_OPTIONS,
  TOKEN_RE,
  UNKNOWN_CAPABILITIES,
  buildPlan,
  buildSegments,
  describeCapabilities,
  segmentsToPlainText,
  validateParams,
};