'use strict';
const {requestHeaders,failure}=require('./hd-transfer');
const {isOfficialDolaFallbackApi,getDolaVideoUrlFromFallbackApi}=require('./dola-original-resolver');
// This adapter uses the selected account's Chromium session and existing proxy.
// Limit both time and response size; signed endpoint addresses never enter logs.
function requestJSON({session,url,headers,signal,requestFactory,timeoutMs=15000}){
 return new Promise((resolve,reject)=>{
  let request,response,timer,done=false,size=0;const chunks=[];
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error){request?.abort();response?.destroy?.();reject(error);}else resolve(value);};
  const abort=()=>finish(failure('ABORT_ERR'));if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});
  if(!isOfficialDolaFallbackApi(url))return finish(failure('ORIGINAL_INVALID_ENDPOINT'));
  try{
   request=(requestFactory||require('electron').net.request)({method:'GET',url,session,credentials:'include',redirect:'error',referrerPolicy:'strict-origin-when-cross-origin',headers:requestHeaders(url,headers)});
   request.on('error',error=>finish(error));request.on('abort',()=>finish(failure('ABORT_ERR')));
   request.on('response',incoming=>{response=incoming;if(incoming.statusCode<200||incoming.statusCode>=300)return finish(failure('HTTP_'+incoming.statusCode));
    incoming.on('error',error=>finish(error));incoming.on('aborted',()=>finish(failure('ORIGINAL_RESPONSE_INTERRUPTED')));
    incoming.on('data',chunk=>{size+=chunk.length;if(size>4*1024*1024)return finish(failure('ORIGINAL_RESPONSE_TOO_LARGE'));chunks.push(chunk);});
    incoming.on('end',()=>{try{const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));finish(null,{ok:true,json:async()=>payload});}catch{finish(failure('ORIGINAL_INVALID_RESPONSE'));}});
   });
   timer=setTimeout(()=>finish(failure('ORIGINAL_TIMEOUT')),timeoutMs);timer.unref?.();request.end();
  }catch(error){finish(error);}
 });
}
async function resolveOriginal({session,fallbackApi,headers,signal,requestFactory}){
 let url;try{url=await getDolaVideoUrlFromFallbackApi(fallbackApi,(url,options)=>requestJSON({session,url,headers:{...headers,Accept:'application/json,text/plain,*/*'},signal:signal?AbortSignal.any([signal,options.signal]):options.signal,requestFactory}));}catch(error){if(error.code==='ABORT_ERR'&&!signal?.aborted)throw failure('ORIGINAL_TIMEOUT');throw error;}
 if(!url)throw failure('ORIGINAL_UNAVAILABLE');return url;
}
module.exports={requestJSON,resolveOriginal};
