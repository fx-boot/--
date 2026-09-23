'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), {randomBytes} = require('node:crypto');
const NAME = /^\d{4}-\d{2}-\d{2}-[a-f0-9]{8}-\d{3,6}\.jsonl$/;
function createStore(directory, options = {}) {
  const maxBytes = options.maxBytes || 5 * 1024 * 1024, maxFiles = options.maxFiles || 20;
  const run = randomBytes(4).toString('hex'); let queue = Promise.resolve(), current = '', day = '', part = 0, size = 0, error = '', pending = 0;
  const now = options.now || (() => new Date());
  async function files() {
    await fs.mkdir(directory, {recursive:true});
    const names = (await fs.readdir(directory)).filter(n => NAME.test(n));
    const values = await Promise.all(names.map(async name => {const s = await fs.lstat(path.join(directory,name)); return s.isFile() && !s.isSymbolicLink() ? {name, size:s.size, modified:s.mtimeMs} : null;}));
    return values.filter(Boolean).sort((a,b) => b.modified-a.modified || b.name.localeCompare(a.name));
  }
  async function prune() {
    const list = await files(), cutoff = now().getTime() - 14*86400000;
    for (const [i,file] of list.entries()) if (file.name !== current && (i >= maxFiles || Date.parse(file.name.slice(0,10)+'T00:00:00Z') < cutoff)) await fs.unlink(path.join(directory,file.name));
  }
  return {
    append(row) {
      const line = JSON.stringify(row)+'\n', bytes = Buffer.byteLength(line);
      if (pending >= 2000) {error='日志写入积压，部分记录仅保留在内存'; options.onError?.(); return;}
      pending++;
      queue = queue.then(async () => {
        const date = now().toISOString().slice(0,10);
        if (!current || day !== date || size + bytes > maxBytes) {
          day = date; current = `${date}-${run}-${String(++part).padStart(3,'0')}.jsonl`; size = 0;
          await fs.mkdir(directory, {recursive:true}); await fs.writeFile(path.join(directory,current),'',{flag:'wx'}); await prune();
        }
        await fs.appendFile(path.join(directory,current),line,'utf8'); size+=bytes;
        if (error) {error='';options.onError?.();}
      }).catch(() => {current='';error='自动保存失败，请检查磁盘空间和目录权限；当前记录仍可导出';options.onError?.();}).finally(() => pending--);
    },
    async list() {await queue; await prune(); return files();},
    async read(name, options = {}) {
      if (!NAME.test(String(name))) throw Error('无效历史日志'); await queue;
      const file=path.join(directory,name), stat=await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes+128*1024) throw Error('历史文件过大或不可读取');
      const text=await fs.readFile(file,'utf8');
      const lines=text.split(/\r?\n/).filter(Boolean);
      return (options.all?lines:lines.slice(-600)).flatMap(line=>{try {const r=JSON.parse(line);return r && typeof r==='object' && typeof r.kind==='string'?[r]:[];}catch{return [];}});
    },
    flush:()=>queue,
    status:()=>({error,pending,file:current}),
  };
}
module.exports={createStore};
