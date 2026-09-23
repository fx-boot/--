'use strict';
const {app, ipcMain, BrowserWindow, dialog, webContents} = require('electron');
const path = require('node:path'), fs = require('node:fs/promises'), {pathToFileURL} = require('node:url');
const {createHash} = require('node:crypto');
const {LIMIT, safeUrl, summarize, payloads, matches, telemetry} = require('./video-log-data');
const {createStore} = require('./video-log-store');
const targets = new Map(), rows = []; let installed = false, enabled = false, selected = '', seq = 0, epoch = 0, notice;
let generation = 0, store, quitting = false;
function storage() {return store ||= createStore(path.join(app.getPath('userData'),'diagnostics','video-history'), {onError:notify});}
const managerUrl = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href;
const allowed = raw => {try {return /(^|\.)(doubao\.com|dola\.com|ciciai\.com)$/.test(new URL(raw).hostname);} catch {return false;}};
function notify() {if (notice) return; notice = setTimeout(() => {notice = null; for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.webContents.getURL() === managerUrl) w.webContents.send('video-log:changed');}, 200);}
function active(t) {return enabled && (!selected || selected === t.accountId) && !t.contents.isDestroyed() && allowed(t.contents.getURL());}
function append(t, kind, fields = {}) {
  if (!active(t)) return;
  if (JSON.stringify(fields.detail || {}).length > 24000) fields.detail = {note: '结构超过 24 KB，已省略；提取的模型、任务 ID 和时长字段仍保留'};
  const groupIds = fields.groupId ? [fields.groupId] : (fields.ids || []).filter(x => /(?:^|\.)(video_id|vid)$/.test(x.path)).map(x => createHash('sha256').update(t.accountId + '\0' + String(x.value)).digest('hex'));
  if (groupIds.length) fields.groupIds = [...new Set(groupIds)];
  const row = {id: ++seq, time: new Date().toISOString(), accountId: t.accountId, kind, ...fields};
  rows.push(row); storage().append(row);
  if (rows.length > 600) rows.splice(0, rows.length - 600); notify();
}
function status() {return {enabled, accountId: selected, total: rows.length, generation, cursor:seq, firstId:rows[0]?.id || seq+1, saving:storage().status(), targets: [...targets.values()].filter(t => active(t)).map(t => ({accountId: t.accountId, ready: t.ready}))};}
function state(input = {}) {
  const after = Number(input.after), reset = input.generation !== generation || !Number.isFinite(after) || after > seq || after < (rows[0]?.id || seq+1)-1;
  return {...status(),reset,rows:reset?rows:rows.filter(r=>r.id>after)};
}
async function attach(t) {
  if (!active(t) || t.connecting) return;
  t.connecting = true;
  try {
    if (!t.contents.debugger.isAttached()) {t.contents.debugger.attach('1.3'); t.owns = true;}
    await t.contents.debugger.sendCommand('Network.enable', {maxTotalBufferSize: 8 * 1024 * 1024, maxResourceBufferSize: LIMIT, maxPostDataSize: LIMIT});
    if (active(t)) {const wasReady = t.ready; t.ready = true; if (!wasReady) append(t, 'system', {note: '已连接；记录实际发出的请求。流式响应在连接结束后解析。'});}
  } catch {t.ready = false; append(t, 'system', {note: '采集连接暂不可用；请关闭该网页的开发者工具后重试。'});} finally {t.connecting = false; notify();}
}
function release(t) {
  t.pending.clear(); t.ready = false;
  // Another manager feature may have acquired this debugger since recording began.
  if (t.owns && !t.brokerState?.ownerToken && t.contents.debugger.isAttached()) {try {t.contents.debugger.detach();} catch {}}
  t.owns = false;
}
async function event(t, method, p) {
  if (!active(t)) return;
  const currentEpoch = epoch;
  const valid = () => active(t) && currentEpoch === epoch;
  if (method === 'Network.requestWillBeSent') {
    const r = p.request; if (!r || !allowed(r.url) || telemetry(r.url) || /upload|attachment|telemetry|analytics|report|collect/i.test(new URL(r.url).pathname)) return;
    const candidate = /chat|conversation|video|generate|task|completion/i.test(new URL(r.url).pathname) || /ability_type|video|seedance/i.test(r.postData || '');
    if (!candidate || !['XHR', 'Fetch', 'Other'].includes(p.type)) return;
    let raw = r.postData || '';
    if (!raw && r.hasPostData) {try {raw = (await t.contents.debugger.sendCommand('Network.getRequestPostData', {requestId: p.requestId})).postData || '';} catch {}}
    if (!valid()) return;
    const summary = summarize(payloads(raw)[0] || {}), confirmed = summary.video || /video|seedance/i.test(new URL(r.url).pathname);
    const req = {requestId: `${t.contents.id}:${p.requestId}`, url: safeUrl(r.url), method: r.method, ...summary};
    const item = {req, confirmed, time: Date.now(), bytes: 0}; t.pending.set(p.requestId, item);
    while (t.pending.size > 100) t.pending.delete(t.pending.keys().next().value);
    if (confirmed) append(t, 'request', {...req, note: raw.length > LIMIT ? '请求超过采集上限，正文未解析' : '浏览器网络层实际发送的参数；duration 原值不等于成片时长'});
  } else if (method === 'Network.responseReceived') {
    const item = t.pending.get(p.requestId); if (!item) return;
    item.status = p.response.status; item.mime = p.response.mimeType || '';
    if (item.confirmed) append(t, 'response', {requestId: item.req.requestId, url: item.req.url, status: item.status, note: '已收到响应头，等待响应正文'});
  } else if (method === 'Network.dataReceived') {
    const item = t.pending.get(p.requestId); if (item) item.bytes += p.dataLength || 0;
  } else if (method === 'Network.loadingFailed') {
    const item = t.pending.get(p.requestId); t.pending.delete(p.requestId);
    if (item?.confirmed) append(t, 'error', {requestId: item.req.requestId, url: item.req.url, note: p.canceled ? '请求已取消' : '网络请求失败', code: /^net::ERR_[A-Z_]+$/.test(p.errorText) ? p.errorText : 'NETWORK_ERROR'});
  } else if (method === 'Network.loadingFinished') {
    const item = t.pending.get(p.requestId); t.pending.delete(p.requestId); if (!item) return;
    if (item.bytes > LIMIT || (item.mime && !/json|event-stream|text|octet-stream/i.test(item.mime))) {
      if (item.confirmed) append(t, 'response', {requestId: item.req.requestId, status: item.status, note: '正文过大或非文本，已跳过；可保存原片检查实际时长'}); return;
    }
    try {
      const body = await t.contents.debugger.sendCommand('Network.getResponseBody', {requestId: p.requestId}); if (!valid()) return;
      const raw = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      const summaries = payloads(raw).map(summarize), relevant = summaries.filter(s => s.video || s.durations.length || s.ids.length);
      if (!item.confirmed && !summaries.some(s => s.video)) return;
      if (!item.confirmed) append(t, 'request', {...item.req, note: '响应包含视频字段，回溯关联请求'});
      const chosen = relevant.length ? relevant.slice(-15) : summaries.slice(-1);
      for (const summary of chosen) append(t, 'response', {requestId: item.req.requestId, url: item.req.url, status: item.status, ...summary, note: '服务端返回字段；单位未注明的 duration 保留原值，不作为成片证据'});
      if (!chosen.length) append(t, 'response', {requestId: item.req.requestId, status: item.status, note: '正文为空、非 JSON/SSE 或超过 512 KB；未提取参数'});
    } catch {if (valid() && item.confirmed) append(t, 'error', {requestId: item.req.requestId, note: '浏览器未保留响应正文；请求记录仍可查看'});}
  }
}
function register(accountId, contents, brokerState) {
  if (targets.has(contents.id)) {targets.get(contents.id).brokerState = brokerState; return;}
  const t = {accountId, contents, brokerState, pending: new Map(), ready: false, owns: false, media: new Set()}; targets.set(contents.id, t);
  contents.debugger.on('message', (_e, method, p) => {void event(t, method, p).catch(() => {});});
  contents.debugger.on('detach', () => {t.ready = false; t.owns = false; t.pending.clear(); if (active(t)) append(t, 'system', {note: '采集连接中断，期间请求无法补录；将自动重连'});});
  contents.on('did-navigate', () => {t.pending.clear(); t.media.clear(); if (active(t)) void attach(t);});
  contents.once('destroyed', () => {targets.delete(contents.id); notify();});
  if (active(t)) void attach(t);
}
function discover() {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed() || contents.getType() !== 'webview' || !allowed(contents.getURL())) continue;
    const account = require('./hd-original-service').accountFor(contents);
    if (account) register(account.id, contents, targets.get(contents.id)?.brokerState);
  }
}
function recordMedia(accountId, quality, groupId, source) {
  const t = [...targets.values()].find(t => t.accountId === accountId && active(t)); if (!t || !Number.isFinite(quality.duration)) return;
  append(t, 'media', {groupId, source, durations: [{path: 'ffprobe.duration', value: quality.duration, seconds: quality.duration, unit: 's'}], detail: {width: quality.width, height: quality.height}, note: '已下载文件的实测时长；通过原片组 ID 对照，不自动归因到最近请求'});
}
function install() {
  if (installed) return; installed = true;
  const Broker = require('./webview-debugger-broker').WebviewDebuggerBroker, previous = Broker.prototype.register;
  Broker.prototype.register = function(id, contents) {const result = previous.call(this, id, contents); register(String(id), contents, result); return result;};
  const handle = (name, fn) => ipcMain.handle('video-log:' + name, (e, input) => {if (e.sender.isDestroyed() || e.sender.getURL() !== managerUrl || (e.senderFrame && e.senderFrame !== e.sender.mainFrame)) throw Error('无效窗口'); return fn(e, input);});
  handle('list', (_e,input) => state(input));
  handle('status', () => status());
  handle('history', async (_e,name) => name ? {rows:await storage().read(name)} : {files:await storage().list()});
  handle('set', async (_e, input = {}) => {
    epoch++; enabled = !!input.enabled; selected = String(input.accountId || '').slice(0, 120);
    if (enabled) discover();
    for (const t of targets.values()) {t.pending.clear(); if (!active(t)) release(t);}
    await Promise.all([...targets.values()].filter(active).map(attach)); notify(); return state();
  });
  handle('clear', () => {epoch++; generation++; rows.length = 0; for (const t of targets.values()) {t.pending.clear(); t.media.clear();} notify(); return {ok: true};});
  handle('export', async (e, filter = {}) => {
    const source = filter.history ? await storage().read(filter.history,{all:true}) : rows;
    const snapshot = source.filter(r => matches(r, filter));
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {title: '导出筛选后的视频日志', defaultPath: '豆包视频日志-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl', filters: [{name: 'JSON Lines', extensions: ['jsonl']}]});
    if (result.canceled || !result.filePath) return {canceled: true};
    await fs.writeFile(result.filePath, snapshot.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8'); return {count: snapshot.length};
  });
  const timer = setInterval(() => {if (enabled) discover(); for (const t of targets.values()) {
    for (const [id, item] of t.pending) if (Date.now() - item.time > 10 * 60 * 1000) {t.pending.delete(id); if (item.confirmed) append(t, 'system', {requestId: item.req.requestId, note: '响应超过 10 分钟，已结束跟踪；流式正文可能未收齐'});}
    if (active(t) && !t.ready) void attach(t);
  }}, 5000); timer.unref();
  app.on('before-quit', event => {
    enabled = false; clearInterval(timer); for (const t of targets.values()) release(t);
    if (!quitting && store) {event.preventDefault(); quitting = true; void store.flush().finally(()=>app.quit());}
  });
}
module.exports = {install, recordMedia};
