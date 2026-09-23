'use strict';
const fs=require('node:fs'),{Transform}=require('node:stream'),{pipeline}=require('node:stream/promises');
function errorCode(error){return String(error?.code||error?.cause?.code||String(error?.message||'').match(/(?:net::)?(ERR_[A-Z_]+)/)?.[1]||'DOWNLOAD_FAILED').replace(/[^A-Z0-9_]/g,'').slice(0,80);}
function failure(code,message){return Object.assign(Error(message||code),{code});}
function requestHeaders(url,headers={}){
 const result={...headers};const key=Object.keys(result).find(k=>k.toLowerCase()==='referer');
 if(key){const value=result[key];delete result[key];try{const from=new URL(value),to=new URL(url);from.username='';from.password='';from.hash='';
  if(['http:','https:'].includes(from.protocol)&&!(from.protocol==='https:'&&to.protocol!=='https:'))result.Referer=from.origin===to.origin?from.href:from.origin+'/';
 }catch{}}
 return result;
}
function describe(error){const code=errorCode(error);
 if(code==='ABORT_ERR')return '已取消下载';
 if(code.startsWith('ORIGINAL_'))return '平台原片接口暂未返回可保存的原片（'+code+'），请重新打开视频并扫描；没有自动改下播放压缩版';
 if(code==='ERR_BLOCKED_BY_CLIENT')return '下载请求被客户端拦截（ERR_BLOCKED_BY_CLIENT），请保留此错误信息以检查请求策略';
 if(code==='ENOSPC')return '保存磁盘空间不足，请选择其他磁盘';
 if(['EACCES','EPERM','EBUSY'].includes(code))return '保存目录无写入权限或文件被占用，请改存到下载文件夹';
 if(code==='ENOENT')return '保存目录不存在或磁盘已断开，请重新选择位置';
 if(code==='HTTP_401'||code==='HTTP_403')return '视频链接已过期或服务器拒绝访问（'+code.replace('_',' ')+ '），请重新打开视频并扫描';
 if(code==='HTTP_404'||code==='HTTP_410')return '原片链接已失效，请重新打开生成结果并扫描';
 if(code==='HTTP_429')return '平台暂时限制下载频率（HTTP 429），请稍后再试';
 if(/PROXY|TUNNEL|SOCKS/.test(code))return '账号代理连接失败（'+code+'），请检查 FlClash 当前节点及代理连接';
 if(/CERT|SSL/.test(code))return '视频连接的证书或 TLS 校验失败（'+code+'），请检查代理连接及系统时间';
 if(code==='IDLE_TIMEOUT')return '下载连接连续 90 秒没有数据，请检查当前节点后重试';
 if(['INCOMPLETE_VIDEO','PARTIAL_CONTENT','ERR_CONTENT_LENGTH_MISMATCH','ERR_STREAM_PREMATURE_CLOSE'].includes(code))return '视频传输中断或只返回了部分文件（'+code+'），请重新下载';
 if(code==='NOT_VIDEO')return '链接返回了网页或分片播放清单，请重新打开视频并扫描原片';
 if(code==='PROBE_UNAVAILABLE')return error.message;
 if(code==='EMPTY_VIDEO')return '服务器没有返回视频内容，请重新扫描';
 return '下载失败（'+code+'），请检查连接后重试；诊断记录已保存';
}
function retryable(error){return /^(ERR_(CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|TIMED_OUT|NETWORK_CHANGED|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR|CONTENT_LENGTH_MISMATCH|STREAM_PREMATURE_CLOSE)|ECONNRESET|ETIMEDOUT|IDLE_TIMEOUT|INCOMPLETE_VIDEO|HTTP_50[234])$/.test(errorCode(error));}
// Electron's native request uses Chromium's proxy and Cookie store. No Node
// fetch, alternate network route or manually copied Cookie header is used.
function downloadStream({session,url,headers,destination,signal,onProgress=()=>{},idleMs=90000,requestFactory}){
 return new Promise((resolve,reject)=>{
  let request,response,timer,streamDone,settled=false,received=0,total=0;const stop=new AbortController();
  const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error){stop.abort();request?.abort();response?.destroy?.();if(streamDone)void streamDone.catch(()=>{}).then(()=>reject(error));else reject(error);}else resolve({received,total});};
  const touch=()=>{clearTimeout(timer);timer=setTimeout(()=>finish(failure('IDLE_TIMEOUT')),idleMs);timer.unref?.();};
  const abort=()=>finish(failure('ABORT_ERR'));
  if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});
  try{
   // Chromium rejects a manually supplied cross-origin full-path Referer before
   // sending data. Match its default policy rather than disabling that policy.
   request=(requestFactory||require('electron').net.request)({method:'GET',url,session,credentials:'include',redirect:'follow',referrerPolicy:'strict-origin-when-cross-origin',headers:{...requestHeaders(url,headers),'Accept-Encoding':'identity'}});
   request.on('error',error=>finish(error));
   request.on('abort',()=>{if(!settled)finish(failure('ABORT_ERR'));});
   request.on('response',async incoming=>{
    response=incoming;const header=name=>{const value=incoming.headers[name];return Array.isArray(value)?value[0]:String(value||'');};
    if(incoming.statusCode<200||incoming.statusCode>=300)return finish(failure('HTTP_'+incoming.statusCode));
    if(/text\/|json|mpegurl|dash\+xml/i.test(header('content-type')))return finish(failure('NOT_VIDEO'));
    total=Number(header('content-length'))||0;onProgress({received,total});touch();
    const count=new Transform({transform(chunk,_encoding,done){received+=chunk.length;touch();onProgress({received,total});done(null,chunk);}});
    try{
     streamDone=pipeline(incoming,count,fs.createWriteStream(destination,{flags:'wx'}),{signal:stop.signal});await streamDone;
     if(!received)throw failure('EMPTY_VIDEO');
     if(total&&(!header('content-encoding')||header('content-encoding')==='identity')&&received!==total)throw failure('INCOMPLETE_VIDEO');
     if(incoming.statusCode===206){const match=header('content-range').match(/^bytes 0-(\d+)\/(\d+)$/);if(!match||Number(match[1])+1!==received||Number(match[2])!==received)throw failure('PARTIAL_CONTENT');}
     finish();
    }catch(error){finish(error);}
   });
   touch();request.end();
  }catch(error){finish(error);}
 });
}
module.exports={downloadStream,errorCode,describe,retryable,failure,requestHeaders};
