'use strict';
(() => {
  const api = window.managerVideoLogAPI; if (!api) return;
  const {matches,durationType,groupRows} = window.managerVideoLogData;
  const trigger = document.createElement('button'); trigger.id = 'showVideoLog'; trigger.className = 'toolbar-btn'; trigger.textContent = '视频日志'; document.querySelector('.top-actions').prepend(trigger);
  const overlay = document.createElement('div'); overlay.id = 'videoLogModal'; overlay.className = 'overlay hidden';
  overlay.innerHTML = `<section class="modal video-log-modal" role="dialog" aria-modal="true" aria-labelledby="vlTitle">
    <div class="modal-title"><div><h2 id="vlTitle">视频生成日志</h2><p>对照发送参数、服务端返回和成片实测时长</p></div><button class="modal-close" id="vlClose" aria-label="关闭视频日志">×</button></div>
    <div class="vl-controls"><select id="vlCapture" aria-label="采集账号"></select><button id="vlStart" class="primary-action">开始记录</button><button id="vlStop" class="secondary-action">停止记录</button><button id="vlExport" class="secondary-action">导出筛选结果</button><button id="vlClear" class="secondary-action">清空当前视图</button></div>
    <p class="vl-note">生成前开始记录，关闭面板后仍会采集。脱敏日志自动保存，按日期和大小分卷，最多保留 14 天、20 卷，每卷约 5 MB。当前视图和每个历史分卷最多显示最近 600 条；历史导出包含该卷全部匹配记录。清空视图不会删除已保存的历史。</p>
    <p class="vl-note">按请求、任务或视频 ID 自动归组；没有相同 ID 的记录会分开显示。时长筛选只匹配单位明确的生成与成片时长，排除处理耗时。返回参数不等于成片结果，保存“高清原片”后可查看文件实测。流式响应结束后解析，正文上限 512 KB。</p>
    <div class="vl-controls"><select id="vlHistory" aria-label="历史日志"><option value="">本次记录</option></select><button id="vlReloadHistory" class="secondary-action">刷新历史</button><select id="vlAccount" aria-label="筛选账号"></select><select id="vlKind" aria-label="筛选记录类型"><option value="">全部类型</option><option value="request">发送请求</option><option value="response">服务端返回</option><option value="media">文件实测</option><option value="error">错误</option><option value="system">采集状态</option></select><input id="vlQuery" aria-label="搜索日志" placeholder="搜索模型、任务 ID、字段" maxlength="100"><input id="vlMin" type="number" min="0" max="3600" step="0.01" placeholder="最短秒数" aria-label="最短秒数"><input id="vlMax" type="number" min="0" max="3600" step="0.01" placeholder="最长秒数" aria-label="最长秒数"><button id="vlRange" class="secondary-action">16–30 秒</button></div>
    <div id="vlStatus" class="vl-status" role="status"></div><div id="vlList" class="vl-list"></div>
  </section>`; document.body.append(overlay);
  const el = id => document.getElementById(id), names = new Map(); let data = {rows: [], targets: []}, liveRows=[], cursor=0, generation=-1, historyLoaded='', loading = false, pending = false, optionKey = '', rendered = '', message = '', lastAccounts=0;
  const kinds = {request: '发送请求', response: '服务端返回', media: '文件实测', error: '错误', system: '采集状态'};
  const filter = () => ({accountId: el('vlAccount').value, kind: el('vlKind').value, query: el('vlQuery').value.trim(), minSeconds:el('vlMin').value,maxSeconds:el('vlMax').value,history:el('vlHistory').value});
  const categories={requested:'请求时长',reported:'返回时长',measured:'成片实测',processing:'处理耗时',unknown:'未分类字段'};
  async function historyList() {const result=await api.history(),select=el('vlHistory'),saved=select.value;select.replaceChildren();for(const file of [{name:'',label:'本次记录'},...result.files.map(f=>({...f,label:f.name+' · '+Math.ceil(f.size/1024)+' KB'}))]){const o=document.createElement('option');o.value=file.name;o.textContent=file.label;select.append(o);}select.value=saved;}
  function render() {
    trigger.dataset.recording = String(data.enabled); trigger.textContent = data.enabled ? '视频日志 · 记录中' : '视频日志';
    el('vlStart').disabled = !!data.enabled; el('vlStop').disabled = !data.enabled; el('vlCapture').disabled = !!data.enabled;
    const visible = data.rows.filter(r => matches(r, filter()));
    const ready = data.targets.filter(t => t.ready).length;
    el('vlClear').disabled=!!el('vlHistory').value;
    el('vlStatus').textContent = data.saving?.error || message || `${data.enabled ? `记录中 · 已连接 ${ready} 个账号网页${ready ? '' : '，请打开所选账号网页'}` : '已停止记录'} · ${el('vlHistory').value?'历史':'本次'}筛选 ${visible.length} / ${data.rows.length} 条 · ${data.saving?.pending?'正在自动保存':'自动保存已就绪'}`;
    const key = JSON.stringify([visible.map(r => r.id), filter(),optionKey]); if (key === rendered) return; rendered = key;
    const open = new Set([...el('vlList').querySelectorAll('details[open]')].map(x => x.dataset.id)); el('vlList').replaceChildren();
    if (!visible.length) {const empty = document.createElement('div'); empty.className = 'vl-empty'; empty.textContent = data.rows.length ? '没有符合当前筛选条件的记录。' : '尚无记录。选择账号并点击“开始记录”，关闭面板后在账号网页生成视频，再回来查看。'; el('vlList').append(empty);}
    for (const group of groupRows(data.rows)) {
      const selectedRows=group.rows.filter(r=>matches(r,filter()));if(!selectedRows.length)continue;
      const section=document.createElement('section');section.className='vl-task';
      const heading=document.createElement('h4');const ids=[...new Set(group.rows.flatMap(r=>(r.ids||[]).filter(i=>i.value&&/(task_id|job_id|video_id|vid)$/.test(i.path)).map(i=>String(i.value))))];
      heading.textContent=(names.get(group.rows[0].accountId)||group.rows[0].accountId)+' · '+(ids[0]||group.rows.find(r=>r.requestId)?.requestId||'采集状态 / 未关联记录');section.append(heading);
      for (const row of selectedRows.slice().reverse()) {
      const detail = document.createElement('details'); detail.className = 'vl-row'; detail.dataset.id = String(row.id); detail.open = open.has(String(row.id));
      const title = document.createElement('summary');
      const duration = (row.durations || []).filter(d=>(d.category||durationType(d.path,row.kind))!=='processing').slice(0,4).map(d => `${categories[d.category||durationType(d.path,row.kind)]}: ${d.value}${d.unit === 'unspecified' ? '（单位待确认）' : d.unit}`).join(' · ');
      title.textContent = `${new Date(row.time).toLocaleTimeString()} · ${names.get(row.accountId) || row.accountId} · ${kinds[row.kind]}${row.status ? ' · HTTP ' + row.status : ''}${row.models?.length ? ' · ' + row.models.join(', ') : ''}${duration ? ' · ' + duration : ''} — ${row.note || row.url || ''}`;
      const pre = document.createElement('pre'); detail.append(title, pre);detail.addEventListener('toggle',()=>{if(detail.open&&!pre.textContent)pre.textContent=JSON.stringify(row,null,2);});if(detail.open)pre.textContent=JSON.stringify(row,null,2);section.append(detail);
      }
      el('vlList').append(section);
    }
  }
  async function refresh() {
    if (loading) {pending = true; return;} loading = true;
    try {
      if (overlay.classList.contains('hidden')) {const s=await api.status();trigger.dataset.recording=String(s.enabled);trigger.textContent=s.enabled?'视频日志 · 记录中':'视频日志';return;}
      const history=el('vlHistory').value;
      let snapshot;
      if(history){snapshot=await api.status();if(historyLoaded!==history){data.rows=(await api.history(history)).rows;historyLoaded=history;}}
      else {snapshot=await api.list({after:cursor,generation});liveRows=snapshot.reset?snapshot.rows:[...liveRows,...snapshot.rows].filter(r=>r.id>=snapshot.firstId);cursor=snapshot.cursor;generation=snapshot.generation;data.rows=liveRows;historyLoaded='';}
      data={...data,...snapshot,rows:data.rows};
      if(Date.now()-lastAccounts>5000){
      const all=await window.managerAPI.accounts.list();lastAccounts=Date.now();
      const accounts = Array.isArray(all) ? all : all.accounts || [], options = accounts.map(a => ({id: String(a.id), name: a.name || a.email || a.id}));
      if (JSON.stringify(options) !== optionKey) {
        optionKey = JSON.stringify(options); names.clear(); options.forEach(a => names.set(a.id, a.name));
        for (const id of ['vlAccount', 'vlCapture']) {const select = el(id), saved = select.value; select.replaceChildren(); for (const a of [{id: '', name: '全部账号'}, ...options]) {const o = document.createElement('option'); o.value = a.id; o.textContent = a.name; select.append(o);} select.value = saved;}
      }
      }
      if (data.enabled) el('vlCapture').value = data.accountId; render();
    } catch (e) {el('vlStatus').textContent = String(e.message || e);} finally {loading = false; if (pending) {pending = false; void refresh();}}
  }
  const act = fn => async () => {message = ''; try {await fn(); await refresh();} catch (e) {el('vlStatus').textContent = String(e.message || e);}};
  el('vlStart').onclick = act(() => api.set({enabled: true, accountId: el('vlCapture').value}));
  el('vlStop').onclick = act(() => api.set({enabled: false}));
  el('vlClear').onclick = act(() => api.clear());
  el('vlExport').onclick = act(async () => {const result = await api.export(filter()); message = result.canceled ? '已取消导出' : `已导出 ${result.count} 条筛选记录`;});
  el('vlHistory').onchange=()=>{historyLoaded='';rendered='';void refresh();};
  el('vlReloadHistory').onclick=act(async()=>{await historyList();historyLoaded='';});
  el('vlRange').onclick=()=>{el('vlMin').value='16';el('vlMax').value='30';message='';render();};
  for (const id of ['vlAccount', 'vlKind', 'vlQuery', 'vlMin','vlMax']) el(id).addEventListener('input', () => {message = ''; render();});
  trigger.onclick = () => {overlay.classList.remove('hidden'); message = '';lastAccounts=0;void historyList().then(refresh).catch(e=>{el('vlStatus').textContent=e.message;});el('vlClose').focus();};
  el('vlClose').onclick = () => {overlay.classList.add('hidden'); trigger.focus();};
  overlay.addEventListener('keydown', e => {if (e.key === 'Escape') el('vlClose').click(); if (e.key === 'Tab') {const nodes = [...overlay.querySelectorAll('button:not(:disabled), select:not(:disabled), input, summary')]; const first = nodes[0], last = nodes.at(-1); if (e.shiftKey && document.activeElement === first) {e.preventDefault(); last.focus();} else if (!e.shiftKey && document.activeElement === last) {e.preventDefault(); first.focus();}}});
  api.onChanged(() => {void refresh().catch(() => {});});
})();
