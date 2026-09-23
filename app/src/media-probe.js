'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { fraction } = require('./video-quality');
function parseProbe(payload) {
  const stream = (payload.streams || []).find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!stream || !(Number(stream.width)>0 && Number(stream.height)>0)) return {status:'unavailable',message:'未发现可读取的视频轨道'};
  const rotation = Number(stream.side_data_list?.find(s => Number.isFinite(Number(s.rotation)))?.rotation || stream.tags?.rotate || 0);
  const rotated = Math.abs(Math.round(rotation/90))%2 === 1;
  const number = value => Number.isFinite(Number(value)) && Number(value)>0 ? Number(value) : 0;
  return {status:'ready',width:Number(rotated?stream.height:stream.width),height:Number(rotated?stream.width:stream.height),
    fps:fraction(stream.avg_frame_rate),codec:String(stream.codec_name||''),videoBitrate:number(stream.bit_rate),
    totalBitrate:number(payload.format?.bit_rate),duration:number(stream.duration||payload.format?.duration),measuredAt:new Date().toISOString()};
}
function createMediaProbe({ executable, onResult = () => {}, maxConcurrent = 2, run = execFile }) {
  const cache = new Map();
  const queue = [];
  let running = 0;
  function drain() {
    while (running < maxConcurrent && queue.length) {
      const task = queue.shift(); running++;
      task().finally(() => { running--; drain(); });
    }
  }
  function read(file, stat) {
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    const previous = cache.get(file);
    if (previous?.stamp === stamp) return previous;
    // Bound memory; never evict an active probe that another caller awaits.
    if (cache.size >= 500) for (const [key,item] of cache) { if (item.result.status !== 'pending') {cache.delete(key);break;} }
    let resolve;
    const entry = {stamp,result:{status:'pending'},done:new Promise(r => {resolve=r;})};
    cache.set(file,entry);
    queue.push(async () => {
      let result;
      try {
        const real = await fs.realpath(file);
        const current = await fs.stat(real);
        if (!current.isFile() || `${current.size}:${current.mtimeMs}` !== stamp) throw Error('changed');
        const stdout = await new Promise((res,rej) => run(executable,[
          '-v','error','-protocol_whitelist','file','-probesize','5000000','-analyzeduration','5000000',
          '-show_entries','stream=codec_type,codec_name,width,height,avg_frame_rate,bit_rate,duration:stream_disposition=attached_pic:stream_side_data=rotation:stream_tags=rotate:format=bit_rate,duration',
          '-of','json',path.resolve(real)
        ],{windowsHide:true,timeout:15000,maxBuffer:1024*1024},(err,out) => err?rej(err):res(out)));
        result = parseProbe(JSON.parse(stdout));
      } catch(e) { result={status:'unavailable',message:e.code==='ENOENT'?'画质检测组件缺失':'画质暂不可读取（文件不完整或格式不支持）'}; }
      entry.result=result;resolve(result);
      if (cache.get(file) === entry) {try{onResult(file,result);}catch{}}
    });
    drain();return entry;
  }
  return {
    peek(file, stat) {return read(file,stat).result;},
    async inspect(file) {try {const stat=await fs.stat(file);if(!stat.isFile())throw Error('not file');return read(file,stat).done;}catch{return {status:'unavailable',message:'文件不存在或不可读取'};}},
  };
}
module.exports={createMediaProbe,parseProbe};
