"use strict";
/**
 * 平台视频能力表
 *
 * ⚠ dola 的取值全部来自 2026-09-23 对真实 dola.com 视频生成界面的实测 DOM 探测，
 *   不是行业常见值、也不是按命名推测：
 *   - 模型：视频模式工具栏 `video-model` 菜单实际只有
 *     「Dreamina Seedance 2.5 / Dreamina Seedance 2.0 Fast / Dreamina Seedance 1.0」。
 *     此前写的 seedance2.0mini 在平台上并不存在（会导致静默用平台默认模型生成）。
 *   - 时长：`video-duration` 菜单实际只有 5s / 10s。
 *     15/30/auto 平台均未提供；应用自带的 30 秒增强要求模型为 2.5 且
 *     localStorage `dbm_dola_enable_30s_v1` 为 1，属可选增强，不作为默认能力。
 *   - 比例：`video-ratio` 菜单实际给出 1:1 / 3:4 / 4:3 / 9:16 / 16:9 / 21:9。
 *
 * 驱动层每次设置参数后都会回读控件文本；回读不一致即阻断提交，不会用平台默认值继续。
 *
 * doubao 目标本工作台未使用，保留原结构但同样不含未核实能力。
 */
const VIDEO_CAPABILITIES = Object.freeze({
  schemaVersion: 1,
  targets: Object.freeze({
    doubao: Object.freeze({
      name: "豆包",
      models: Object.freeze(["seedance2.5", "seedance2.0fast", "seedance1.0"]),
      durations: Object.freeze(["5", "10"]),
      ratios: Object.freeze(["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"]),
      watermark: "official-no-watermark",
    }),
    dola: Object.freeze({
      name: "Dola",
      models: Object.freeze(["seedance2.5", "seedance2.0fast", "seedance1.0"]),
      durations: Object.freeze(["5", "10"]),
      /**
       * 时长增强（复用应用自身已有的 dola-duration-enhancer）：
       *   实测 2026-09-23：增强器由 webview-preload 注入页面主世界，且已确认
       *   `__DBM_DOLA_30_SECOND_ENHANCER__=true`、fetch/XHR 均被 patch。
       *   生效条件（来自实现本身，不是猜）：
       *     1) 当前模型必须是 Seedance 2.5（读工具栏 video-model 文案判断）
       *     2) localStorage dbm_dola_enable_30s_v1 === "1"
       *     3) 秒数取 dbm_dola_duration_seconds_v2，合法区间 16—30，超出则回落到 30
       *   生效方式：改写请求体里 ability_type===17 的 ability_param.duration
       *   —— 也就是「实际提交时长」由请求体决定，而不是平台控件文案。
       *   工具栏文案改写与 16—30 网格依赖页面可见（元素尺寸为 0 时增强器会跳过），
       *   因此界面不得以工具栏文案作为「实际时长」的证据。
       */
      enhancedDuration: Object.freeze({
        from: 16,
        to: 30,
        requiresModel: "seedance2.5",
        enableKey: "dbm_dola_enable_30s_v1",
        secondsKey: "dbm_dola_duration_seconds_v2",
        mechanism: "request-patch",
        measuredAt: "2026-09-23",
      }),
      ratios: Object.freeze(["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"]),
      watermark: "official-no-watermark",
      executionEngine: "manager-chromium-webview",
      cdpIsolation: "webcontents-debugger-ipc",
      measuredAt: "2026-09-23",
    }),
  }),
});

/** 模型标识 → 平台菜单里的实际文案（驱动层据此匹配菜单项，匹配不到即阻断） */
const MODEL_MENU_LABEL = Object.freeze({
  "seedance2.5": "Seedance 2.5",
  "seedance2.0fast": "Seedance 2.0 Fast",
  "seedance1.0": "Seedance 1.0",
});

/**
 * 模型标识 → 选完后工具栏触发器上显示的短名（实测：选 2.5 时按钮文本是「模型 2.5」）。
 * 回读用它，而不是菜单里的长文案。
 */
const MODEL_TRIGGER_LABEL = Object.freeze({
  "seedance2.5": "2.5",
  "seedance2.0fast": "2.0 Fast",
  "seedance1.0": "1.0",
});

function normalizeVideoTask(input = {}) {
  const targetPlatform = input.targetPlatform === "dola" ? "dola" : "doubao";
  const caps = VIDEO_CAPABILITIES.targets[targetPlatform];
  const model = String(input.model || "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const requested = String(input.duration ?? "10").trim().toLowerCase();
  return {
    targetPlatform,
    // 认不出的模型原样保留，交由能力校验拒绝；不替换成另一个模型
    model: caps.models.includes(model) ? model : String(input.model || ""),
    // auto / 30 / 15 平台均未提供，回落到已核实的 10s，不伪造更高档位
    duration: caps.durations.includes(requested) ? requested : "10",
    removeWatermark: input.removeWatermark !== false,
  };
}

module.exports = { MODEL_MENU_LABEL, MODEL_TRIGGER_LABEL, VIDEO_CAPABILITIES, normalizeVideoTask };