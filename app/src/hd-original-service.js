'use strict';
const {app,ipcMain,BrowserWindow,webContents}=require('electron');
const fs=require('node:fs/promises'),fsSync=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {downloadStream,errorCode,describe,retryable,failure}=require('./hd-transfer');
const {resolveOriginal}=require('./hd-original-request');
const {createMediaProbe}=require('./media-probe'),quality=require('./video-quality'),{createParser}=require('./hd-candidates');
const parser=createParser(),registry=new Map(),groups=new Map(),jobs=new Map();let installed=false;
const probe=createMediaProbe({executable:path.join(process.resourcesPath,'media-tools/ffprobe.exe')});
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function trusted(event){if(event.sender.isDestroyed()||!event.sender.getURL().startsWith('file:')||!event.sender.getURL().endsWith('/renderer/index.html'))throw Error('无效窗口');}
function accountFor(contents){
 let entry=registry.get(contents.id);if(entry)return entry;
 const storage=path.basename(contents.session.storagePath||'');if(!storage.startsWith('doubao-manager-'))return null;
 const id=storage.slice('doubao-manager-'.length);if(!/^[\w-]{1,120}$/.test(id))return null;
 try{const accounts=JSON.parse(fsSync.readFileSync(path.join(app.getPath('userData'),'accounts.json'),'utf8'));if(!Array.isArray(accounts)||!accounts.some(a=>a.id===id))return null;}catch{return null;}
 entry={id,contents};const contentsId=contents.id;registry.set(contentsId,entry);contents.once('destroyed',()=>registry.delete(contentsId));return entry;
}
const variantKey=v=>v.source==='official'?'official-original':digest(v.url);
function publicGroup(group){return {id:group.id,accountId:group.accountId,title:group.title,variants:group.variants.map((v,i)=>({id:variantKey(v),index:i,width:v.width,height:v.height,bitrate:v.bitrate,size:v.size,definition:v.definition,codec:v.codec,source:v.source||'playback'})),updatedAt:group.updatedAt};}
function notify(){for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed()&&win.webContents.getURL().endsWith('/renderer/index.html'))win.webContents.send('hd:changed');}
function prune(){for(const [id,g] of groups)if(Date.now()-g.updatedAt>30*60*1000)groups.delete(id);while(groups.size>200)groups.delete(groups.keys().next().value);}
function observe(event,input){
 const contents=event.sender;if(contents.isDestroyed()||contents.getType()!=='webview')return;
 try{const u=new URL(contents.getURL());if(!/(^|\.)(doubao\.com|dola\.com|ciciai\.com)$/i.test(u.hostname))return;}catch{return;}
 const account=accountFor(contents);if(!account||!Array.isArray(input))return;
 for(const incoming of input.slice(0,60)){
  if(!incoming||!Array.isArray(incoming.variants))continue;const unique=new Map();
  for(const v of incoming.variants.slice(0,30)){if(!v||typeof v!=='object')continue;const url=parser.url(v.url);if(!url)continue;const n=x=>Math.max(0,Math.min(100000000,Number(x)||0));unique.set(url,{url,width:n(v.width),height:n(v.height),bitrate:n(v.bitrate),size:Math.max(0,Math.min(1e12,Number(v.size)||0)),definition:String(v.definition||'').slice(0,40),codec:String(v.codec||'').slice(0,40)});}
  const fallbackApi=parser.fallback(incoming.fallbackApi);let variants=quality.sorted([...unique.values()]);if(!variants.length&&!fallbackApi)continue;
  const id=digest(account.id+'\0'+String(incoming.id||fallbackApi||variants[0]?.url).slice(0,16000));
  const previous=groups.get(id);const freshPrevious=previous&&Date.now()-previous.updatedAt<30*60*1000;
  if(freshPrevious){const merged=new Map(variants.map(v=>[v.url,v]));for(const v of previous.variants)if(v.source!=='official'&&!merged.has(v.url))merged.set(v.url,v);variants=quality.sorted([...merged.values()]).slice(0,29);}
  const original=fallbackApi||(freshPrevious&&previous.variants.find(v=>v.source==='official')?.url);if(original)variants.unshift({url:original,source:'official',width:0,height:0});
  groups.set(id,{id,accountId:account.id,contentsId:contents.id,pageUrl:contents.getURL(),title:String(incoming.title||'视频原片').slice(0,100),variants,updatedAt:Date.now()});
 }
 prune();notify();
}
function publicJob(job){const {controller,...result}=job;return result;}
async function saveUnique(temp,desired){const ext=path.extname(desired)||'.mp4',stem=path.basename(desired,path.extname(desired));for(let i=0;i<10000;i++){const target=path.join(path.dirname(desired),stem+(i?` (${i})`:'')+ext);try{await fs.copyFile(temp,target,fsSync.constants.COPYFILE_EXCL);return target;}catch(error){if(error.code!=='EEXIST')throw error;}}throw Error('同名文件过多，请选择其他名称');}
function recordDiagnostic(job,error,variant){
 const dir=path.join(app.getPath('userData'),'diagnostics'),file=path.join(dir,'hd-download.jsonl');
 try{fsSync.mkdirSync(dir,{recursive:true});if(fsSync.existsSync(file)&&fsSync.statSync(file).size>1024*1024){fsSync.copyFileSync(file,file+'.previous');fsSync.writeFileSync(file,'');}fsSync.appendFileSync(file,JSON.stringify({at:new Date().toISOString(),jobId:job.id,stage:job.stage,code:errorCode(error),host:new URL(variant.url).hostname,received:job.received,total:job.total,attempt:job.attempt,electron:process.versions.electron})+'\n');}catch{}
}
async function transfer(job,contents,variant,desired,referer){
 const temporary=path.join(path.dirname(desired),'.dbm-hd-'+crypto.randomUUID()+'.part');let last=0;
 try{
  job.status='downloading';job.stage='prepare';notify();
  await fs.access(path.dirname(desired),fsSync.constants.W_OK);
  if(variant.source==='official'){
   job.stage='resolve-original';notify();
   const url=await resolveOriginal({session:contents.session,fallbackApi:variant.url,headers:{Referer:referer,'User-Agent':contents.getUserAgent()},signal:job.controller.signal});
   variant={...variant,url};job.source='official';
  }
  for(let attempt=1;attempt<=2;attempt++){
   job.attempt=attempt;job.received=0;job.total=0;job.stage='network';notify();
   try{await downloadStream({session:contents.session,url:variant.url,signal:job.controller.signal,destination:temporary,headers:{Referer:referer,'User-Agent':contents.getUserAgent(),Accept:'video/*,application/octet-stream;q=0.9,*/*;q=0.8'},onProgress:p=>{job.received=p.received;job.total=p.total;if(Date.now()-last>350){last=Date.now();notify();}}});break;}
   catch(error){recordDiagnostic(job,error,variant);await fs.rm(temporary,{force:true}).catch(()=>{});if(attempt===2||job.controller.signal.aborted||!retryable(error))throw error;}
  }
  if(job.controller.signal.aborted)throw failure('ABORT_ERR');
  job.status='checking';job.stage='probe';notify();const actual=await probe.inspect(temporary);
  if(actual.status!=='ready'||!actual.width||!actual.height)throw failure('PROBE_UNAVAILABLE','视频已经传输，但'+(actual.message||'无法检测完整视频，请重新下载'));
  if(job.controller.signal.aborted)throw failure('ABORT_ERR');
  job.stage='save';job.file=await saveUnique(temporary,desired);job.quality=actual;job.status='completed';
  try{require('./video-log-service').recordMedia(job.accountId,actual,job.groupId,job.source);}catch{}
 }catch(error){job.status=job.controller.signal.aborted?'canceled':'failed';job.error=job.status==='canceled'?'已取消':describe(error);job.errorCode=errorCode(error);recordDiagnostic(job,error,variant);}
 finally{await fs.rm(temporary,{force:true}).catch(()=>{});notify();}
}

function install(){
 if(installed)return;installed=true;
 const Broker=require('./webview-debugger-broker').WebviewDebuggerBroker,originalRegister=Broker.prototype.register;
 Broker.prototype.register=function(accountId,contents){const result=originalRegister.apply(this,arguments);if(contents){registry.set(contents.id,{id:String(accountId),contents});const id=contents.id;contents.once('destroyed',()=>registry.delete(id));}return result;};
 // Preserve the core account deletion handler and block it only during a new HD transfer.
 const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(name,fn)=>handle(name,name==='accounts:delete'?function(event,id,...args){if([...jobs.values()].some(j=>j.accountId===id&&['choosing','downloading','checking'].includes(j.status)))throw Error('该账号正在下载高清原片，请完成或取消下载后再删除');return fn(event,id,...args);}:fn);
 ipcMain.on('hd:observe',observe);
 handle('hd:list',event=>{trusted(event);prune();return {groups:[...groups.values()].map(publicGroup),jobs:[...jobs.values()].map(publicJob)};});
 handle('hd:scan',async(event,accountId)=>{trusted(event);let scanned=0;for(const contents of webContents.getAllWebContents()){if(contents.isDestroyed()||contents.getType()!=='webview')continue;const account=accountFor(contents);if(account?.id===accountId){await contents.executeJavaScript('window.__DBM_HD_OBSERVER__?.scan()').catch(()=>{});scanned++;}}return {scanned};});
 handle('hd:download',async(event,input)=>{
  trusted(event);prune();const group=groups.get(input?.groupId),variant=group?.variants.find(v=>variantKey(v)===input?.variantId);if(!group||!variant)throw Error('提取记录已过期，请重新扫描');
  const contents=webContents.fromId(group.contentsId);if(!contents||contents.isDestroyed()||accountFor(contents)?.id!==group.accountId)throw Error('该账号网页已关闭，请重新打开后提取');
  if([...jobs.values()].some(j=>j.groupId===group.id&&['choosing','downloading','checking'].includes(j.status)))throw Error('此视频正在下载');
  if([...jobs.values()].filter(j=>['choosing','downloading','checking'].includes(j.status)).length>=2)throw Error('已有两个下载进行中，请完成后再试');
  while(jobs.size>=30){const completed=[...jobs].find(([,j])=>['completed','failed','canceled'].includes(j.status));if(!completed)break;jobs.delete(completed[0]);}
  const id=crypto.randomUUID(),job={id,accountId:group.accountId,groupId:group.id,title:group.title,variantId:input.variantId,status:'choosing',received:0,total:0,controller:new AbortController()};jobs.set(id,job);
  let result;try{const {dialog}=require('electron');result=await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender),{title:'保存最高可用画质原片',defaultPath:path.join(app.getPath('downloads'),'视频原片-'+new Date().toISOString().replace(/[:.]/g,'-')+'.mp4'),filters:[{name:'视频原片',extensions:['mp4','webm','mov','mkv']}]});}catch{jobs.delete(id);throw Error('无法打开保存窗口');}
  if(result.canceled||!result.filePath){jobs.delete(id);notify();return {canceled:true};}
  void transfer(job,contents,variant,result.filePath,group.pageUrl);return {id};
 });
 handle('hd:cancel',(event,id)=>{trusted(event);const job=jobs.get(id);if(job&&['downloading','checking'].includes(job.status))job.controller.abort();return {ok:true};});
 handle('hd:reveal',async(event,id)=>{trusted(event);const job=jobs.get(id);if(job?.status!=='completed')throw Error('文件尚未下载完成');require('electron').shell.showItemInFolder(job.file);return {ok:true};});
 app.on('before-quit',()=>{for(const job of jobs.values())job.controller.abort();});
}
module.exports={install,saveUnique,accountFor};
// 工作台下载链路复用同一份观察结果（含 fallbackApi）：只读访问器，不改变既有 HD 行为。
// 返回的是内部结构（带 fallbackApi），仅限主进程内部使用，不要直接透给渲染层。
module.exports.groupsForAccount=accountId=>[...groups.values()].filter(g=>g.accountId===accountId);
module.exports.scanAccount=async accountId=>{let scanned=0;for(const contents of webContents.getAllWebContents()){if(contents.isDestroyed()||contents.getType()!=='webview')continue;if(accountFor(contents)?.id===accountId){await contents.executeJavaScript('window.__DBM_HD_OBSERVER__?.scan()').catch(()=>{});scanned++;}}return {scanned};};
