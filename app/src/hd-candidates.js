'use strict';
function createParser() {
 const number=x=>Number.isFinite(Number(x))&&Number(x)>0?Number(x):0;
 function fallback(value){if(typeof value!=='string'||value.length>16000)return '';try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&/(^|\.)byteintlapi\.com$/i.test(u.hostname)&&/^\/video\/fplay(?:\/|$)/i.test(u.pathname)?u.href:'';}catch{return '';}}
 function url(value){if(typeof value!=='string'||value.length>16000)return '';let text=value.trim();if(!/^https?:\/\//i.test(text)){try{text=atob(text.replace(/-/g,'+').replace(/_/g,'/'));}catch{return '';}}try{const u=new URL(text);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!/\.(m3u8|mpd|jpe?g|png|webp|gif|svg)(?:$|\/)/i.test(u.pathname)?text:'';}catch{return '';}}
 function variant(item,parent={}){
  if(!item||typeof item!=='object')return [];
  const meta={width:number(item.vwidth||item.width||parent.width),height:number(item.vheight||item.height||parent.height),bitrate:number(item.real_bitrate||item.bit_rate||item.bitrate||parent.bitrate),size:number(item.size||item.file_size||parent.size),codec:String(item.codec_type||item.codec||parent.codec||'').slice(0,40),definition:String(item.definition||item.quality||parent.definition||'').slice(0,40)};
  const values=[];
  for(const key of ['main_url','backup_url','backup_url_1','play_url','download_url','original_url','origin_url','url']){const parsed=url(item[key]);if(parsed)values.push({...meta,...(key==='download_url'&&item.video_model?{width:0,height:0}:{}),url:parsed});}
  for(const list of [item.url_list,item.backup_urls])if(Array.isArray(list))for(const value of list.slice(0,5)){const parsed=url(value);if(parsed)values.push({...meta,url:parsed});}
  for(const key of ['play_addr','download_addr','play_addr_h264','play_addr_265','original_video_info','original_media_info'])if(item[key]&&item[key]!==item)values.push(...variantLeaf(item[key],meta));
  return values;
 }
 function variantLeaf(item,parent){const leaf={...item};for(const key of ['play_addr','download_addr','play_addr_h264','play_addr_265','original_video_info','original_media_info'])delete leaf[key];return variant(leaf,parent);}
 function parse(payload){const groups=[],seen=new Set();let visited=0;
  function walk(node,at,depth){if(!node||typeof node!=='object'||depth>14||++visited>6000||groups.length>=60||seen.has(node))return;seen.add(node);
   if(Array.isArray(node)){node.slice(0,300).forEach((value,i)=>walk(value,at+'['+i+']',depth+1));return;}
   const entries=[];
   let model=node.video_model;if(typeof model==='string'&&model.length<1048576){try{model=JSON.parse(model);}catch{model=null;}}
   if(model&&typeof model==='object'&&(!node.vid||!model.video_id||node.vid===model.video_id)){
    const versions=model.video_list;if(versions&&typeof versions==='object')for(const value of Object.values(versions).slice(0,30))if(value&&typeof value==='object')entries.push(value);
   }
   for(const key of ['bit_rate','bitrate_versions','video_versions'])if(Array.isArray(node[key]))entries.push(...node[key].slice(0,30));
   if(node.video_list&&!Array.isArray(node.video_list)&&typeof node.video_list==='object')for(const [name,value] of Object.entries(node.video_list).slice(0,30))if(/^(video_\d+|\d+p|hd|sd|fhd|uhd|original)$/i.test(name)&&value&&typeof value==='object')entries.push({...value,definition:value.definition||name});
   const isVideo=entries.length||node.video_id||node.vid||node.play_addr||/(?:^|\.)(video|video_info|original_video_info|original_media_info)$/.test(at);
   let variants=isVideo?[...variant(node),...entries.flatMap(value=>variant(value,node))]:[];
   const unique=new Map();for(const v of variants)if(!unique.has(v.url))unique.set(v.url,v);variants=[...unique.values()].slice(0,30);
   const matchingModel=model&&typeof model==='object'&&(!node.vid||!model.video_id||node.vid===model.video_id)?model:null;
   const fallbackApi=fallback(matchingModel?.fallback_api||node.fallback_api);
   if(variants.length||fallbackApi){groups.push({id:String(node.video_id||node.vid||matchingModel?.video_id||fallbackApi||variants[0].url).slice(0,16000),title:String(node.title||node.desc||'视频原片').slice(0,100),...(fallbackApi?{fallbackApi}:{}),variants});return;}
   for(const [key,value] of Object.entries(node).slice(0,150)){if(value&&typeof value==='object')walk(value,at?at+'.'+key:key,depth+1);else if(typeof value==='string'&&value.length<1048576&&/^[\s]*[\[{]/.test(value)){try{walk(JSON.parse(value),key,depth+1);}catch{}}}
  }
  walk(payload,'',0);return groups;
 }
 return {parse,url,fallback};
}
module.exports={createParser};
