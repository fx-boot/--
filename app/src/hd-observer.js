'use strict';
function installObserver(createParser){
 if(window.__DBM_HD_OBSERVER__)return;const parser=createParser(),limit=4*1024*1024,cache=new Map();let active=0;
 function publish(groups){for(const g of groups){cache.set(g.id,{group:g,at:Date.now()});}while(cache.size>60)cache.delete(cache.keys().next().value);if(groups.length)window.postMessage({source:'dbm-hd-observer',groups},'*');}
 async function capture(response){
  if(active>=8)return;const type=response.headers.get('content-type')||'',stream=/event-stream/i.test(type);
  if(!/json|event-stream/i.test(type)||Number(response.headers.get('content-length'))>limit)return;
  const reader=response.clone().body?.getReader();if(!reader)return;active++;const chunks=[],decoder=new TextDecoder();let size=0,pending='';
  function events(final=false){let end;while((end=pending.search(/\r?\n\r?\n/))>=0){const event=pending.slice(0,end);pending=pending.slice(end).replace(/^\r?\n\r?\n/,'');const data=event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');try{publish(parser.parse(JSON.parse(data)));}catch{}}if(final&&pending){pending+='\n\n';events();}}
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit){void reader.cancel().catch(()=>{});return;}if(stream){pending+=decoder.decode(part.value,{stream:true});events();}else chunks.push(part.value);}if(stream){pending+=decoder.decode();events(true);}else{const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}publish(parser.parse(JSON.parse(decoder.decode(bytes))));}}catch{}finally{active--;}
 }
 const fetch=window.fetch;window.fetch=async function(){const response=await fetch.apply(this,arguments);void capture(response).catch(()=>{});return response;};
 const send=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(){this.addEventListener('load',()=>{try{if(this.responseType==='json')publish(parser.parse(this.response));else if((!this.responseType||this.responseType==='text')&&this.responseText.length<=limit&&/json/i.test(this.getResponseHeader('content-type')||''))publish(parser.parse(JSON.parse(this.responseText)));}catch{}},{once:true});return send.apply(this,arguments);};
 function scan(){const groups=[...cache.values()].filter(v=>Date.now()-v.at<30*60*1000).map(v=>v.group);for(const video of [...document.querySelectorAll('video')].slice(0,30)){const url=parser.url(video.currentSrc||video.src||video.querySelector('source')?.src);if(url&&!groups.some(g=>g.variants.some(v=>v.url===url)))groups.push({id:url,title:'页面视频',variants:[{url,width:video.videoWidth,height:video.videoHeight}]});}if(groups.length)window.postMessage({source:'dbm-hd-observer',groups:groups.slice(0,60)},'*');return groups.length;}
 window.__DBM_HD_OBSERVER__={scan};window.addEventListener('DOMContentLoaded',scan,{once:true});
}
module.exports={installObserver};
