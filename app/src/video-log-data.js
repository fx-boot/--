'use strict';
// Keep diagnostic fields; never persist arbitrary prompts, credentials or signed URLs.
const LIMIT = 512 * 1024;
const secret = /cookie|authorization|password|passwd|secret|token|signature|credential|session|email|phone|prompt|content|text|message|description|title/i;
const visible = /^(?:model(?:_id|_name|_version)?|video_model|engine|ability_type|task_id|creation_task_id|generation_task_id|job_id|video_id|vid|request_id|status|state|code|error_code|event|type|duration(?:_.*)?|video_duration(?:_.*)?|seconds?|length|time_len|generate_duration|max_duration|resolution|ratio|fps|width|height)$/i;
const containers = /^(content|message|messages|content_block|content_blocks|video_content|creation_content)$/i;
const {telemetry,durationType,durationSeconds,matches}=require('../renderer/video-log-shared');
function safeUrl(raw) { try { const u = new URL(raw); return u.origin + u.pathname.replace(/[A-Za-z0-9_=-]{64,}/g, '[redacted]').slice(0, 600); } catch { return ''; } }
function parse(raw) { if (typeof raw !== 'string') return raw; if (raw.length > LIMIT) return null; try { return JSON.parse(raw); } catch { return null; } }
function summarize(input) {
  let visited = 0, video = false; const durations = [], models = [], ids = [];
  function walk(value, key = '', at = '', depth = 0) {
    if (++visited > 4000 || depth > 16) return '[limited]';
    if (/video|seedance/i.test(key) || (key === 'ability_type' && Number(value) === 17)) video = true;
    if (typeof value === 'string') {
      const parsed = /^[\s]*[\[{]/.test(value) ? parse(value) : null;
      // Serialized ability parameters and event envelopes are inspected recursively.
      if (parsed && typeof parsed === 'object' && !/cookie|authorization|password|secret|token|credential|session/i.test(key)) return walk(parsed, key, at, depth + 1);
      if (/https?:\/\//i.test(value)) return '[url omitted]';
      if (secret.test(key)) return '[redacted]';
      if (!visible.test(key)) return '[text omitted]';
      value = value.slice(0, 160).replace(/[\r\n\t]/g, ' ');
    }
    if (value && typeof value === 'object') {
      if (secret.test(key) && !containers.test(key)) return '[redacted]';
      if (Array.isArray(value)) return value.slice(0, 80).map((v, i) => walk(v, key, `${at}[${i}]`, depth + 1));
      const out = {};
      for (const [k, v] of Object.entries(value).slice(0, 100)) {
        const label = k.slice(0, 100); Object.defineProperty(out, label, {value: walk(v, label, at ? `${at}.${label}` : label, depth + 1), enumerable: true});
      }
      return out;
    }
    if (secret.test(key)) return '[redacted]';
    if (/^(?:duration(?:_(?:ms|s|sec|second|seconds))?|video_duration(?:_ms)?|seconds?|length|time_len|generate_duration|max_duration)$/i.test(key)) {
      const n = typeof value === 'number' ? value : /^\d+(?:\.\d+)?(?:s|秒)?$/.test(String(value)) ? parseFloat(value) : NaN;
      if (Number.isFinite(n) && n >= 0 && durations.length < 40) {
        const category = durationType(at), unit = /_ms$/i.test(key) ? 'ms' : category === 'requested' || /(?:_s|_sec|_second|_seconds)$|^seconds?$/i.test(key) || /s|秒$/.test(String(value)) ? 's' : 'unspecified';
        durations.push({path: at, value, category, unit, ...(unit === 'ms' ? {seconds:n/1000} : unit === 's' ? {seconds:n} : {})});
      }
    }
    if (/model|engine/i.test(key) && visible.test(key) && models.length < 15) {models.push(String(value)); if (/video|seedance/i.test(String(value))) video = true;}
    if (/^(task_id|creation_task_id|generation_task_id|job_id|video_id|vid|request_id)$/.test(key) && ids.length < 20) ids.push({path: at, value});
    return value;
  }
  const detail = walk(input);
  return {video, durations, models: [...new Set(models)], ids, detail};
}
function payloads(raw) {
  const obj = parse(raw); if (obj !== null) return [obj];
  if (typeof raw !== 'string' || raw.length > LIMIT) return [];
  return raw.split(/\r?\n\r?\n/).slice(-200).flatMap(event => {
    const data = event.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
    const parsed = parse(data); return parsed !== null ? [parsed] : [];
  });
}
module.exports = {LIMIT, safeUrl, summarize, payloads, matches, telemetry, durationType, durationSeconds};
