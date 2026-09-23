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

const { MODEL_MENU_LABEL, MODEL_TRIGGER_LABEL, VIDEO_CAPABILITIES } = require("./video-capabilities");

const TOKEN_RE = /@图(\d{1,3})/g;

/** 平台未提供、因此界面必须显示「未知」的能力项（比例已实测核实，不再列入） */
const UNKNOWN_CAPABILITIES = Object.freeze(["maxReferenceImages", "quota"]);

/**
 * 选择器全部来自 2026-09-23 对真实 dola.com 视频生成界面的实测：
 *   - 聊天模式下工具栏控件数量为 0，必须先点「视频生成」按钮进入视频模式；
 *   - 进入视频模式后才有 video-model / video-duration / video-ratio 三个 radix 触发器；
 *   - 编辑器是 tiptap 的 contenteditable，不是 textarea；
 *   - 发送按钮 id 固定为 flow-end-msg-send，编辑器为空时处于 disabled。
 */
const DOLA_SELECTORS = Object.freeze({
  // 视频模式下的真实编辑器（tiptap/ProseMirror）优先，其次才退回到通用 contenteditable
  editor: 'div.tiptap.ProseMirror[contenteditable="true"], [contenteditable="true"], textarea',
  videoModeButton: 'button[data-skill-id="skill_bar_button_17"]',
  modelControl: '[data-input-engine-actionbar-control-key="video-model"]',
  durationControl: '[data-input-engine-actionbar-control-key="video-duration"]',
  ratioControl: '[data-input-engine-actionbar-control-key="video-ratio"]',
  actionbar: '[data-input-engine-actionbar]',
  sendButton: '#flow-end-msg-send',
  // radix 菜单（实测结构，2026-09-23）：
  //   触发器 button[data-slot="dropdown-menu-trigger"]（打开时 data-state="open"，文本就是当前值）
  //   内容   div[role="menu"][data-slot="dropdown-menu-content"][data-state="open"]（挂在 body 下）
  //   选项   div[role="menuitem"][data-slot="dropdown-menu-item"]
  // 注意：触发器自身也能匹配 [data-slot*="dropdown-menu"]，若把它当菜单会选中错误节点，
  // 因此菜单容器只认 role（触发器没有 role）。
  menu: '[role="menu"], [role="listbox"]',
  menuItem: '[role="menuitem"], [role="option"]',
  menuTriggerSlot: "dropdown-menu-trigger",
  option: '[role="menuitem"], [role="option"], li, button, div',
  atomicMark: "\uFFFC",
  fileInput: 'input[type="file"]',
});

/** 取目标平台的能力；未传入时用应用自身的能力表 */
const capabilitiesFor = (capabilities, target = "dola") =>
  (capabilities || VIDEO_CAPABILITIES)?.targets?.[target] || null;

const modelOptionsFor = (capabilities, target = "dola") =>
  [...(capabilitiesFor(capabilities, target)?.models || [])].map(String);
const durationOptionsFor = (capabilities, target = "dola") =>
  [...(capabilitiesFor(capabilities, target)?.durations || [])].map(String);
const ratioOptionsFor = (capabilities, target = "dola") =>
  [...(capabilitiesFor(capabilities, target)?.ratios || [])].map(String);

/** 模型标识 → 平台菜单里的实际文案；认不出就原样返回，由驱动层匹配失败后阻断 */
const menuLabelForModel = (model) => MODEL_MENU_LABEL[String(model || "")] || String(model || "");

/** 模型标识 → 选完后工具栏触发器上显示的短名（回读用；实测 2.5 显示为「模型 2.5」） */
const triggerLabelForModel = (model) => MODEL_TRIGGER_LABEL[String(model || "")] || String(model || "");

/**
 * 分镜 × 账号的分配计划（纯逻辑）
 *   - 默认 "distribute"：多条分镜按顺序分配给所选账号，每条分镜只执行一次；
 *   - "compare"：同一分镜在每个所选账号各执行一次，属对比模式，必须显式选择。
 */
function assignStoryboards({ storyboardIds = [], accountIds = [], mode = "distribute" } = {}) {
  const boards = [...new Set(storyboardIds.map(String).filter(Boolean))];
  const accounts = [...new Set(accountIds.map(String).filter(Boolean))];
  if (!boards.length || !accounts.length) return [];
  if (mode === "compare") {
    return boards.flatMap((storyboardId) =>
      accounts.map((accountId) => ({ storyboardId, accountId, mode: "compare" }))
    );
  }
  return boards.map((storyboardId, index) => ({
    storyboardId,
    accountId: accounts[index % accounts.length],
    mode: "distribute",
  }));
}

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
  const caps = capabilitiesFor(capabilities, target);
  const durations = (caps?.durations || []).map(String);
  return {
    target,
    name: caps?.name || target,
    models: (caps?.models || []).map(String),
    // 模型标识对应的平台菜单文案：界面与驱动层共用同一份映射
    modelLabels: (caps?.models || []).map((model) => ({ value: String(model), label: menuLabelForModel(model) })),
    durations,
    ratios: (caps?.ratios || []).map(String),
    watermark: caps?.watermark || "",
    executionEngine: caps?.executionEngine || "",
    measuredAt: caps?.measuredAt || "",
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
 * 平台不支持的模型/时长/比例一律拒绝，不做静默降级。
 */
function validateParams({ target = "dola", params = {}, refs = [], capabilities = null } = {}) {
  const errors = [];
  const warnings = [];
  const caps = capabilitiesFor(capabilities, target);

  if (!caps) errors.push(`平台 ${target} 不在能力表中，拒绝提交`);

  const model = text(params.model);
  if (!model) errors.push("未选择模型");
  else if (caps && !(caps.models || []).map(String).includes(model)) {
    errors.push(`模型 ${model} 不在平台能力表中，拒绝提交`);
  }

  const duration = text(params.duration);
  if (!duration) errors.push("未选择时长");
  else if (caps && !(caps.durations || []).map(String).includes(duration)) {
    errors.push(`时长 ${duration} 不在平台能力表中，拒绝提交`);
  }

  // 比例已实测核实：用户选了什么就必须在平台上设成什么，不支持的直接拒绝
  const ratio = text(params.ratio);
  if (ratio) {
    if (!caps || !Array.isArray(caps.ratios) || !caps.ratios.length) {
      errors.push(`平台未声明比例能力，无法核实比例 ${ratio}，拒绝提交`);
    } else if (!caps.ratios.map(String).includes(ratio)) {
      errors.push(`比例 ${ratio} 不在平台能力表中，拒绝提交`);
    }
  } else {
    warnings.push("未设置比例：将使用平台默认比例，平台不提供回读，具体值无法核实");
  }

  if (!text(params.prompt).trim()) errors.push("提示词为空，拒绝提交");

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
  else
    limitations.push(
      `参考图片以编辑器内联原子节点插入，位置与 @图片 标记一致（共 ${uploads.length} 张）；提交前会回读编辑器里的原子节点数量`
    );
  if (validation.warnings.length) limitations.push(...validation.warnings);
  limitations.push("平台未提供生成进度百分比，只能按阶段与等待时长展示");

  const model = text(attempt?.params?.model);
  const ratio = text(attempt?.params?.ratio);
  return {
    target,
    valid: validation.ok,
    errors: validation.errors,
    warnings: validation.warnings,
    limitations,
    segments,
    uploads,
    params: {
      model,
      // 平台菜单里的实际文案：驱动层用它匹配菜单项，匹配不到就阻断而不是退回默认值
      modelLabel: menuLabelForModel(model),
      // 选完后触发器上显示的短名：驱动层用它做回读校验
      modelTrigger: triggerLabelForModel(model),
      duration: text(attempt?.params?.duration),
      ratio,
      removeWatermark: attempt?.params?.removeWatermark !== false,
    },
    plainText: segmentsToPlainText(segments),
  };
}

module.exports = {
  DOLA_SELECTORS,
  TOKEN_RE,
  UNKNOWN_CAPABILITIES,
  assignStoryboards,
  buildPlan,
  buildSegments,
  capabilitiesFor,
  describeCapabilities,
  durationOptionsFor,
  menuLabelForModel,
  modelOptionsFor,
  ratioOptionsFor,
  segmentsToPlainText,
  triggerLabelForModel,
  validateParams,
};