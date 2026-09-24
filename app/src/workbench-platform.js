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

/**
 * 平台在会话里给出的「没有开始生成」的明确回复。
 * 实测（2026-09-23 真实提交 att_5344bc651f4b / att_a3ccf555afb4 之后的会话内容）：
 *   - 一次是英文「This is a very long, highly specified 13-shot ... Please confirm one of these options」，
 *     即提示词过长、平台要求先确认生成方式；
 *   - 一次是「出于肖像保护考虑，未认证人脸暂不支持用 Dreamina Seedance 2.5 生成视频」。
 * 这两种都说明「平台收到了请求但没有开始生成」，不能当成「提交结果待确认」。
 */
const PLATFORM_REPLY_PATTERNS = Object.freeze([
  {
    // 实测（2026-09-24 005/008）：会话失效后页面弹出可见登录框，标题就是
    // 「登录以解锁更多功能」。此时点任何入口都不会出现控件，必须让用户重新登录，
    // 不能误判成 NEED_CONFIRM，也绝不能自动重试。该规则放在最前优先命中。
    code: "SESSION_EXPIRED",
    re: /登录以解锁更多功能|请先登录|登录后(?:继续|再|即可)|登录状态(?:已经)?(?:过期|失效|超时)|未登录/i,
    label: "账号登录态已失效，请重新登录该账号后再执行",
  },
  {
    // 实测（2026-09-24 真实提交 att_d56d75641fc4，Dola 004）：平台在会话里直接回
    // 「今天的生成次数已经达到上限，明天再来免费生成吧」。这属于「平台明确拒绝」，
    // 必须标失败并显示原文，绝不自动重试、也不换模型/换账号重发。
    code: "QUOTA_EXHAUSTED",
    re: /生成次数(?:已经)?达到上限|次数已达上限|今日次数(?:已)?用完|额度(?:已)?(?:用完|不足)|明天再来|免费生成次数/i,
    label: "平台拒绝：该账号今日生成次数已达上限（额度用尽），需等额度恢复",
  },
  {
    code: "FACE_UNVERIFIED",
    re: /未认证人脸|肖像保护|未认证.*人脸/i,
    label: "平台拒绝：未认证人脸不支持该模型（可换其它参考图或改用文生视频）",
  },
  {
    code: "POLICY",
    re: /违规|涉嫌|敏感|不合规|未通过审核|不支持生成/i,
    label: "平台拒绝：内容未通过平台规则",
  },
  {
    // 实测原文是「Please confirm one of these options」。
    // 不能只匹配孤零零的「请确认/过长」——那会把页面静态文案、历史会话残留全部误判。
    code: "NEED_CONFIRM",
    re: /Please confirm|请确认[^。\n]{0,40}(?:选项|方式|模型|参数|生成)|提示词过长[^。\n]{0,40}(?:确认|选项)|too extensive/i,
    label: "平台要求先确认生成方式，本次没有开始生成",
  },
]);

/** 从页面文本里判断平台有没有明确「没有开始生成」；认不出返回 null，不臆断 */
function classifyPlatformReply(text) {
  const source = String(text || "");
  if (!source.trim()) return null;
  for (const rule of PLATFORM_REPLY_PATTERNS) {
    if (rule.re.test(source)) {
      const match = source.match(rule.re);
      const at = Math.max(0, (match?.index || 0) - 40);
      return { code: rule.code, label: rule.label, excerpt: source.slice(at, at + 200).trim() };
    }
  }
  return null;
}

/**
 * 「平台是否受理了本次提交」的通用信号（不硬编码整句文案、模型名或额度数字）。
 *   - 说明型信号（生成中/排队中/任务已创建）→ 受理；
 *   - 费用预告（本次使用…生成 + 将消耗…额度）→ 受理（但不等于生成成功，仍需任务 ID 落定）；
 *   - 只有费用预告、没有开始生成字样时记为「弱信号」，同样停止重试，转入监控。
 * 只用于「停止重复提交、转入监控」的判定，绝不据此宣告生成成功。
 */
const ACCEPTANCE_PATTERNS = Object.freeze([
  { code: "GENERATING", re: /正在生成|生成中|已开始生成|排队中|已排队|任务已创建|已提交生成/, strength: "strong" },
  { code: "COST_FORECAST", re: /(消耗|扣除|扣减|花费)[^。；\n]{0,20}(额度|积分|次数)/, strength: "weak" },
  { code: "PLAN_USE", re: /本次(将)?使用[^。；\n]{0,60}生成/, strength: "weak" },
]);

function classifyAcceptance(text) {
  const source = String(text || "");
  if (!source.trim()) return null;
  const hits = [];
  for (const rule of ACCEPTANCE_PATTERNS) {
    const match = source.match(rule.re);
    if (match) {
      const at = Math.max(0, (match.index || 0) - 40);
      hits.push({ code: rule.code, strength: rule.strength, excerpt: source.slice(at, at + 160).trim() });
    }
  }
  if (!hits.length) return null;
  const strong = hits.some((hit) => hit.strength === "strong");
  const hasPlanAndCost = hits.some((h) => h.code === "PLAN_USE") && hits.some((h) => h.code === "COST_FORECAST");
  return {
    accepted: strong || hasPlanAndCost,
    strength: strong || hasPlanAndCost ? "accepted" : "hint",
    codes: hits.map((hit) => hit.code),
    excerpt: hits[0].excerpt,
    note:
      strong || hasPlanAndCost
        ? "平台已受理本次提交（停止重复提交，转入监控；任务 ID 未落定前不算生成成功）"
        : "平台给出了费用预告类提示（停止重复提交，转入监控；不作为生成成功依据）",
  };
}

const text = (value, max = 0) => {
  const out = String(value ?? "");
  return max > 0 ? out.slice(0, max) : out;
};

/** 结构化引用 → 分段计划（保留 @图N 在文本中的出现位置，供界面展示与顺序核对） */
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
      token: match[0],
      number: Number(match[1]) || 0,
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

/**
 * 平台的图片引用能力（实测 2026-09-23，DevTools 直连真实 webview）：
 *   - 上传图片后编辑器里不会出现任何图片节点（`<p>` 始终是空的）；
 *   - 在编辑器里输入 @ 不会唤起引用菜单；"/" 也没有命令菜单；
 *   - 往编辑器粘贴图片不插入任何节点（img 数 0、U+FFFC 数 0）；
 *   - 附件缩略卡没有编号/标签，只有 img 的 alt = 原文件名。
 * 结论：平台的视频编辑器**不支持内联图片节点**，图片只能作为参考图附件按上传顺序生效。
 * 因此这里不再写入 U+FFFC（那会被平台当成普通文本，提交后在消息里显示为方框），
 * 改为：按 @图N 的编号顺序上传附件，并把文本里的 @图N 写成「参考图N」。
 */
const REFERENCE_CAPABILITY = Object.freeze({
  inline: false,
  mechanism: "attachment-order",
  labelPrefix: "参考图",
  measuredAt: "2026-09-23",
  note: "平台视频编辑器不支持内联图片节点（实测：上传后编辑器无图片节点、@ 无引用菜单、粘贴图片无效）。提交方式为「按参考图1..N 的顺序作为附件上传」+ 文本里的 @图N 写成参考图N",
});

/** 引用标签：@图3 → 参考图3 */
const referenceLabel = (token) => {
  const match = String(token || "").match(/^@图(\d{1,3})$/);
  return match ? `${REFERENCE_CAPABILITY.labelPrefix}${match[1]}` : String(token || "");
};

/**
 * 提交给平台的文本：把 @图N 转成「参考图N」（不再写入 U+FFFC 占位符）。
 * 之所以能用编号一一对应，是因为附件按 @图N 的编号升序上传（见 buildPlan.references）。
 */
function toPlatformText(segments) {
  return (segments || [])
    .map((segment) => (segment.kind === "image" ? referenceLabel(segment.token) : segment.value))
    .join("");
}

/** 按 @图N 的编号升序整理引用：保证「参考图N」与第 N 个附件严格对应 */
function orderReferences(segments) {
  const images = (segments || []).filter((segment) => segment.kind === "image");
  const seen = new Set();
  const ordered = [];
  for (const segment of images.slice().sort((a, b) => (a.number || 0) - (b.number || 0))) {
    if (seen.has(segment.token)) continue;
    seen.add(segment.token);
    ordered.push({ ...segment, order: ordered.length + 1, label: referenceLabel(segment.token) });
  }
  return ordered;
}

/** 时长增强能力：来自能力表，未配置就返回 null（界面不得编造秒数） */
function enhancedDurationOf(capabilities, target = "dola") {
  const caps = capabilitiesFor(capabilities, target);
  const spec = caps?.enhancedDuration;
  if (!spec || !Number(spec.from) || !Number(spec.to)) return null;
  const list = [];
  for (let seconds = Number(spec.from); seconds <= Number(spec.to); seconds++) list.push(String(seconds));
  return { ...spec, from: Number(spec.from), to: Number(spec.to), values: list };
}

const isEnhancedDuration = (capabilities, target, duration) => {
  const spec = enhancedDurationOf(capabilities, target);
  return Boolean(spec) && spec.values.includes(String(duration));
};

function describeCapabilities(capabilities, target = "dola") {
  const caps = capabilitiesFor(capabilities, target);
  const durations = (caps?.durations || []).map(String);
  const enhanced = enhancedDurationOf(capabilities, target);
  return {
    target,
    name: caps?.name || target,
    models: (caps?.models || []).map(String),
    // 模型标识对应的平台菜单文案：界面与驱动层共用同一份映射
    modelLabels: (caps?.models || []).map((model) => ({ value: String(model), label: menuLabelForModel(model) })),
    durations,
    // 增强时长（逐秒 16—30）只在满足模型条件时可用；界面据此显示原因
    enhancedDuration: enhanced
      ? {
          values: enhanced.values,
          from: enhanced.from,
          to: enhanced.to,
          requiresModel: enhanced.requiresModel,
          mechanism: enhanced.mechanism,
          note: `仅 ${menuLabelForModel(enhanced.requiresModel)} 可用；由应用自带增强器改写请求体里的时长，实际时长以请求体回读为准`,
        }
      : null,
    ratios: (caps?.ratios || []).map(String),
    watermark: caps?.watermark || "",
    executionEngine: caps?.executionEngine || "",
    measuredAt: caps?.measuredAt || "",
    reference: { ...REFERENCE_CAPABILITY },
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
  const enhanced = enhancedDurationOf(capabilities, target);
  if (!duration) errors.push("未选择时长");
  else if (caps && (caps.durations || []).map(String).includes(duration)) {
    // 平台原生时长（5/10）：直接在控件上设置并回读
  } else if (enhanced && enhanced.values.includes(duration)) {
    // 增强时长（16—30）：只在该模型下可用，且必须由增强器改写请求体 —— 绝不静默降级
    if (model !== enhanced.requiresModel) {
      errors.push(
        `${duration} 秒属于时长增强，仅 ${menuLabelForModel(enhanced.requiresModel)} 可用（当前模型 ${model || "未选择"}）；请改用平台原生的 5/10 秒，或切换模型，不会自动降级`
      );
    }
  } else if (caps) {
    errors.push(`时长 ${duration} 不在平台已核实能力表中，拒绝提交`);
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
  const references = orderReferences(segments);
  const uploads = references.map((item) => item.filePath);
  const validation = validateParams({
    target,
    params: attempt?.params || {},
    refs: references.map((item) => ({ ...item, token: item.token })),
    capabilities,
  });

  const limitations = [];
  if (!uploads.length) limitations.push("本次没有绑定参考图片");
  else
    limitations.push(
      `${REFERENCE_CAPABILITY.note}（本次 ${uploads.length} 张，按 ${references.map((item) => item.label).join("、")} 的顺序上传）`
    );
  if (validation.warnings.length) limitations.push(...validation.warnings);
  limitations.push("平台未提供生成进度百分比，只能按阶段与等待时长展示");

  const model = text(attempt?.params?.model);
  const ratio = text(attempt?.params?.ratio);
  const duration = text(attempt?.params?.duration);
  const enhanced = enhancedDurationOf(capabilities, target);
  const durationMode = enhanced && enhanced.values.includes(duration) ? "enhanced" : "native";
  if (durationMode === "enhanced") {
    limitations.push(
      `${duration} 秒由应用自带时长增强（改写请求体 ability_param.duration）实现，平台控件仍显示原生档位；结果视频的实际时长需以平台产物为准，本层不能保证`
    );
  }
  return {
    target,
    valid: validation.ok,
    errors: validation.errors,
    warnings: validation.warnings,
    limitations,
    segments,
    // 按 @图N 编号升序的引用：第 N 个附件就是「参考图N」
    references,
    uploads,
    params: {
      model,
      modelLabel: menuLabelForModel(model),
      modelTrigger: triggerLabelForModel(model),
      duration,
      durationMode,
      durationEnhancement: durationMode === "enhanced" ? { seconds: duration, requiresModel: enhanced.requiresModel } : null,
      ratio,
      removeWatermark: attempt?.params?.removeWatermark !== false,
    },
    // 真正写进平台编辑器的文本（@图N → 参考图N，不含 U+FFFC）
    platformText: toPlatformText(segments),
  };
}

module.exports = {
  ACCEPTANCE_PATTERNS,
  DOLA_SELECTORS,
  PLATFORM_REPLY_PATTERNS,
  REFERENCE_CAPABILITY,
  TOKEN_RE,
  UNKNOWN_CAPABILITIES,
  assignStoryboards,
  buildPlan,
  buildSegments,
  capabilitiesFor,
  classifyAcceptance,
  classifyPlatformReply,
  describeCapabilities,
  durationOptionsFor,
  enhancedDurationOf,
  isEnhancedDuration,
  menuLabelForModel,
  modelOptionsFor,
  orderReferences,
  ratioOptionsFor,
  referenceLabel,
  toPlatformText,
  triggerLabelForModel,
  validateParams,
};