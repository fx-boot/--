'use strict';
function cleanPromptDuration(input) {
  let text=String(input || ''); const edits=[];
  const number='(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const value=number+'(?:\\s*(?:[-–—~～至到])\\s*'+number+')?\\s*(?:秒钟|秒|分钟|seconds?|secs?|s|minutes?|mins?)(?![a-z])';
  const label='(?:(?:视频|影片|短片|成片|动画|全片|整体|总)\\s*)?(?:时长|长度)\\s*(?:要求|设置|设定)?\\s*(?:控制在|不超过|设为|约为|为|是|约|[:：=])?\\s*'+value+'(?:\\s*(?:左右|以内))?';
  function apply(pattern,replacement='') {
    const stage=[];
    text=text.replace(pattern,(...args)=>{const old=args[0],start=args.at(-2),next=typeof replacement==='function'?replacement(...args):replacement;if(next!==old)stage.push({start,end:start+old.length,text:next});return next;});
    edits.push(...stage.sort((a,b)=>b.start-a.start));
  }
  const clock='(?:\\d{1,2}[:：])?\\d{1,2}[:：]\\d{2}(?:[.,]\\d+)?';
  const timeline=clock+'\\s*(?:[-–—~～至到→➜]+|->)\\s*'+clock+'(?:[ \\t]*[|｜/·，,][ \\t]*(?:时长[：:]?\\s*)?'+value+')?';
  apply(new RegExp('[【（(\\[]\\s*'+timeline+'\\s*[】）)\\]][。.;；]?','gi'));
  apply(new RegExp('([|｜][ \\t]*)?'+timeline+'[。.;；]?','gi'),(_all,separator)=>separator||'');
  apply(new RegExp('[【（(\\[]\\s*'+value+'\\s*[】）)\\]]','gi'));
  apply(new RegExp('[|｜][ \\t]*'+value+'[。.;；]?','gi'));
  apply(new RegExp('[（(]\\s*'+label+'\\s*[）)]','gi'));
  // Remove timing annotations, while preserving the shot description and aspect ratio.
  apply(new RegExp(label,'gi'));
  apply(new RegExp('((?:生成|制作|创作|拍摄|输出)(?:\\s|一段|一个|一条|一部|约|大约)*)'+value+'(?:的)?(?=\\s*(?:视频|影片|短片|动画|成片))','gi'),(_all,prefix)=>prefix);
  apply(new RegExp('\\b((?:generate|create|make|produce)\\s+(?:(?:a|an)\\s+)?)'+number+'\\s*[- ]\\s*(?:second|seconds|sec|minute|minutes)\\s+(?=video|clip|film|animation)','gi'),(_all,prefix)=>prefix);
  apply(new RegExp('\\b(?:video|clip|film|animation)\\s+(?:duration|length)\\s*(?::|=|is)?\\s*'+value,'gi'));
  // Single shot timestamps can directly touch Chinese prose; do not require a word boundary.
  apply(new RegExp('[【（(\\[][ \\t]*'+clock+'[ \\t]*[】）)\\]][。.;；]?','g'));
  apply(new RegExp('(^[ \\t]*|[|｜][ \\t]*)'+clock+'(?![\\d:：])[ \\t]*(?:[|｜。.;；][ \\t]*)?','gm'),(_all,prefix)=>prefix);
  apply(new RegExp('^[ \\t]*'+value+'[ \\t]*[。.;；]?[ \\t]*$','gim'));
  // The button removes explicit duration units throughout the current prompt.
  apply(new RegExp('(?<![a-z\\d_.])'+value,'gi'));
  if(edits.length)apply(/((?:生成|制作|创作|拍摄|输出)(?:一段|一个|一条|一部))的(?=视频|影片|短片|动画|成片)/g,(_all,prefix)=>prefix);
  return {text,edits,changed:edits.length>0};
}
module.exports={cleanPromptDuration};
