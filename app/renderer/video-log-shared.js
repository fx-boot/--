'use strict';
((root) => {
  function telemetry(raw) {try {const u=new URL(raw);return /(^|\.)(mcs|mcs-[\w-]+)\./i.test(u.hostname)||/\/(?:telemetry|analytics|report|collect|tracking)(?:\/|$)/i.test(u.pathname);}catch{return false;}}
  function durationType(at,kind='') {
    if (/ai_creation_duration_info|round_duration_info|duration_info|perf|latency|cost|elapsed|play_start|events\[|\.params\./i.test(at)) return 'processing';
    if (kind==='media'||/^ffprobe\./i.test(at)) return 'measured';
    if (/ability_param\.duration$/.test(at)) return 'requested';
    if (/(?:^|[.\[])video(?:_info|_model)?(?:[.\[]|$)|video_duration/.test(at)) return 'reported';
    return 'unknown';
  }
  function durationSeconds(d,kind='') {
    const type=d.category||durationType(d.path||'',kind), n=Number(d.seconds??d.value);
    if (!['requested','reported','measured'].includes(type)||!Number.isFinite(n)) return null;
    return d.seconds!==undefined||d.unit==='s'||type==='requested'?n:null;
  }
  function matches(row,f={}) {
    if (telemetry(row.url)||(f.accountId&&row.accountId!==f.accountId)||(f.kind&&row.kind!==f.kind)) return false;
    const min=f.thirty?30:f.minSeconds===''||f.minSeconds===undefined?null:Number(f.minSeconds),max=f.maxSeconds===''||f.maxSeconds===undefined?null:Number(f.maxSeconds);
    if ((min!==null||max!==null)&&!(row.durations||[]).some(d=>{const n=durationSeconds(d,row.kind);return n!==null&&(min===null||n>=min)&&(max===null||n<=max);})) return false;
    return !f.query||JSON.stringify(row).toLowerCase().includes(String(f.query).slice(0,100).toLowerCase());
  }
  function groupRows(rows) {
    const parent=rows.map((_,i)=>i), aliases=new Map();
    function find(i) {while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;}
    rows.forEach((r,i)=>{
      const keys=[...(r.requestId?['req:'+r.requestId]:[]),...(r.groupIds||[r.groupId].filter(Boolean)).map(x=>'video:'+x),...(r.ids||[]).filter(x=>x.value&&/(?:^|\.)(task_id|creation_task_id|generation_task_id|job_id)$/.test(x.path)).map(x=>'task:'+x.value)];
      for (const key of keys) {const scoped=r.accountId+'|'+key;if(aliases.has(scoped))parent[find(i)]=find(aliases.get(scoped));else aliases.set(scoped,i);}
    });
    const groups=new Map(); rows.forEach((r,i)=>{const k=find(i);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);});
    return [...groups.values()].map(items=>({key:String(items[0].id),rows:items})).reverse();
  }
  const api={telemetry,durationType,durationSeconds,matches,groupRows};
  if (typeof module!=='undefined'&&module.exports) module.exports=api;else root.managerVideoLogData=api;
})(typeof window!=='undefined'?window:globalThis);
