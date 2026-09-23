'use strict';
function installPromptDurationButton(clean) {
  if(!/(^|\.)(dola\.com|doubao\.com)$/.test(location.hostname))return;
  if(window.__DBM_PROMPT_DURATION_CLEANER__)return;window.__DBM_PROMPT_DURATION_CLEANER__=true;
  const controls='[data-input-engine-actionbar-control-key="video-duration"],[data-input-engine-actionbar-control-key="duration"]',editors='textarea,[contenteditable="true"],[contenteditable="plaintext-only"]';
  let pending;
  const visible=e=>{const r=e?.getBoundingClientRect();return !!(e?.isConnected&&r?.width&&r?.height&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none');};
  function candidates(root){return [...root.querySelectorAll(editors)].filter(e=>visible(e)&&!e.disabled&&!e.readOnly&&!e.parentElement?.closest(editors));}
  function findEditor(control) {
    const active=document.activeElement?.closest?.(editors);if(active&&visible(active)&&!active.disabled&&!active.readOnly)return active;
    for(let root=control.parentElement,i=0;root&&i<5;root=root.parentElement,i++){const list=candidates(root);if(list.length===1)return list[0];if(list.length>1)break;}
    const list=candidates(document);return list.length===1?list[0]:null;
  }
  function textMap(editor) {
    if(editor.tagName==='TEXTAREA')return {text:editor.value};
    let text='',nodes=[];
    const line=()=>{if(text&&!text.endsWith('\n'))text+='\n';};
    function walk(node) {
      if(node.nodeType===Node.TEXT_NODE){nodes.push({node,start:text.length,end:text.length+node.nodeValue.length});text+=node.nodeValue;return;}
      if(node.nodeType!==Node.ELEMENT_NODE)return;
      if(node.getAttribute('contenteditable')==='false'){text+='\uFFFC';return;}
      if(node.tagName==='BR'){text+='\n';return;}
      const block=node!==editor&&/^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE)$/.test(node.tagName);
      if(block)line();for(const child of node.childNodes)walk(child);if(block)line();
    }
    walk(editor);
    return {text,nodes};
  }
  function replace(editor,edit) {
    const map=textMap(editor),point=(offset,end)=>{const item=map.nodes.find(n=>end?offset>n.start&&offset<=n.end:offset>=n.start&&offset<n.end)||(end?[...map.nodes].reverse().find(n=>n.end<=offset):map.nodes.find(n=>n.start>=offset));return item?{node:item.node,offset:Math.max(0,Math.min(item.node.nodeValue.length,offset-item.start))}:null;};
    const from=point(edit.start,false),to=point(edit.end,true);if(!from||!to)throw Error('输入框内容变化，请重试');
    const range=document.createRange();range.setStart(from.node,from.offset);range.setEnd(to.node,to.offset);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    // Use browser editing commands so editor frameworks receive their usual input events.
    if(!document.execCommand('insertText',false,edit.text)) {range.deleteContents();if(edit.text)range.insertNode(document.createTextNode(edit.text));editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));}
  }
  function install() {
    pending=null;
    const control=document.querySelector(controls);if(!control||!control.parentElement)return;
    if(control.parentElement.querySelector('[data-dbm-clean-duration]'))return;
    const button=document.createElement('button');button.type='button';button.setAttribute('data-dbm-clean-duration','true');button.textContent='清除提示词时长';
    button.title='删除当前提示词的视频时长、分镜时间轴和时长标注，保留画面描述';
    button.style.cssText='margin-left:6px;padding:5px 8px;border:1px solid #8886;border-radius:7px;background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap';
    button.addEventListener('mousedown',e=>e.preventDefault());
    button.addEventListener('click',event=>{
      event.preventDefault();event.stopPropagation();const editor=findEditor(control);
      const result=editor?clean(textMap(editor).text):null;
      if(!editor)button.textContent='请先点击提示词输入框';
      else if(!result.changed)button.textContent='没有明确的视频时长';
      else try {
        editor.focus();
        if(editor.tagName==='TEXTAREA'){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,result.text);editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertReplacementText',data:result.text}));}
        else for(const edit of result.edits)replace(editor,edit);
        button.textContent=clean(textMap(editor).text).changed?'处理未完成，请检查输入框':'已清除提示词时长';
      }catch{button.textContent='处理未完成，请检查输入框';}
      setTimeout(()=>{if(button.isConnected)button.textContent='清除提示词时长';},2500);
    });
    control.parentElement.append(button);
  }
  const schedule=()=>{if(!pending)pending=setTimeout(install,100);};
  const observer=new MutationObserver(records=>{if(records.some(r=>[...r.addedNodes].some(n=>n.nodeType===1&&(n.matches(controls)||n.querySelector(controls)))))schedule();});
  const start=()=>{install();observer.observe(document.documentElement,{childList:true,subtree:true});};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  window.addEventListener('pagehide',()=>{observer.disconnect();clearTimeout(pending);pending=null;});window.addEventListener('pageshow',e=>{if(e.persisted)start();});
}
module.exports={installPromptDurationButton};
