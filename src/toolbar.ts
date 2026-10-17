import { COLORS, type InkHost, type InkSession, type Tool } from './types';
const TOOLS: Array<[Tool,string,string]> = [['text','Aa','Type and select text'],['pen','✎','Pen'],['highlighter','▰','Highlighter'],['eraser','⌫','Eraser'],['lasso','◌','Lasso selection'],['line','╱','Line'],['arrow','↗','Arrow'],['rectangle','▭','Rectangle'],['ellipse','◯','Ellipse']];
export function createToolbar(host:InkHost,container:HTMLElement,session:()=>InkSession|null,extra?:{exportSvg?:()=>void;exportPdf?:()=>void}):()=>void {
  const bar=document.createElement('div');bar.className='inkspace-toolbar';bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','Inkspace drawing tools'); container.append(bar);
  const buttons=new Map<string,HTMLButtonElement>();
  const button=(label:string,text:string,action:()=>void)=>{const b=document.createElement('button');b.type='button';b.title=label;b.setAttribute('aria-label',label);b.textContent=text;b.addEventListener('pointerdown',e=>e.preventDefault());b.addEventListener('click',action);bar.append(b);return b;};
  for(const [tool,glyph,label] of TOOLS)buttons.set(tool,button(label,glyph,()=>host.updateSettings({tool})));
  const sep=document.createElement('span');sep.className='inkspace-separator';bar.append(sep);
  const palette=document.createElement('div');palette.className='inkspace-palette';palette.setAttribute('aria-label','Ink colors');bar.append(palette);
  for(const color of COLORS){const b=document.createElement('button');b.type='button';b.className='inkspace-swatch';b.style.background=color;b.title=`Ink color ${color}`;b.setAttribute('aria-label',b.title);b.addEventListener('pointerdown',e=>e.preventDefault());b.onclick=()=>host.updateSettings({color});palette.append(b);buttons.set(color,b);}
  const custom=document.createElement('input');custom.type='color';custom.title='Custom ink color';custom.setAttribute('aria-label',custom.title);custom.className='inkspace-custom-color';custom.oninput=()=>host.updateSettings({color:custom.value});bar.append(custom);
  const width=document.createElement('input');width.type='range';width.min='1';width.max='48';width.step='0.5';width.title='Stroke width';width.setAttribute('aria-label',width.title);width.className='inkspace-width';bar.append(width);
  const widthValue=document.createElement('span');widthValue.className='inkspace-width-value';bar.append(widthValue);
  width.oninput=()=>{const s=host.getSettings();host.updateSettings(s.tool==='highlighter'?{highlighterWidth:Number(width.value)}:s.tool==='eraser'?{eraserSize:Number(width.value)}:{penWidth:Number(width.value)});};
  const safely=(action:()=>void)=>{try{action();}catch(error){host.status(String(error),true);}};
  buttons.set('undo',button('Undo ink','↶',()=>safely(()=>session()?.undo())));buttons.set('redo',button('Redo ink','↷',()=>safely(()=>session()?.redo())));
  const mouse=button('Draw with mouse','⌖',()=>host.updateSettings({mouseDrawing:!host.getSettings().mouseDrawing}));buttons.set('mouse',mouse);
  const more=document.createElement('details');more.className='inkspace-more';const summary=document.createElement('summary');summary.textContent='•••';summary.title='More ink tools';more.append(summary);const menu=document.createElement('div');menu.className='inkspace-more-menu';more.append(menu);bar.append(more);
  const menuButton=(label:string,action:()=>void)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>{more.open=false;action();};menu.append(b);};
  menuButton('Save ink now',()=>void session()?.flush().then(()=>host.status('Ink saved.')).catch(e=>host.status(String(e),true)));
  menuButton('Stable writing layout',()=>host.updateSettings({stableLayout:!host.getSettings().stableLayout}));
  menuButton('Zoom in',()=>host.updateSettings({zoom:Math.min(2,host.getSettings().zoom+.1)}));
  menuButton('Zoom out',()=>host.updateSettings({zoom:Math.max(.4,host.getSettings().zoom-.1)}));
  menuButton('Zoom: 100%',()=>host.updateSettings({zoom:1}));
  menuButton('Fit writing width',()=>{const editor=container.closest('.cm-editor');const scroller=editor?.querySelector<HTMLElement>('.cm-scroller');if(scroller)host.updateSettings({zoom:Math.max(.4,Math.min(1,(scroller.clientWidth-32)/host.getSettings().writingWidth))});});
  for(const paper of ['plain','ruled','grid','dots'] as const)menuButton(`Paper: ${paper}`,()=>host.updateSettings({paper}));
  if(extra?.exportSvg)menuButton('Export ink as SVG',extra.exportSvg);
  if(extra?.exportPdf)menuButton('Export annotated PDF',extra.exportPdf);
  const status=document.createElement('span');status.className='inkspace-tool-status';status.setAttribute('aria-live','polite');bar.append(status);
  let unsubSession:(()=>void)|undefined,active:InkSession|null=null;
  const update=()=>{const s=host.getSettings();for(const [key,b]of buttons){const selected=key===s.tool||key===s.color||(key==='mouse'&&s.mouseDrawing);b.classList.toggle('is-active',selected);if(key!=='undo'&&key!=='redo')b.setAttribute('aria-pressed',String(selected));}custom.value=s.color;
    const n=s.tool==='highlighter'?s.highlighterWidth:s.tool==='eraser'?s.eraserSize:s.penWidth;width.value=String(n);widthValue.textContent=`${n}`;
    const current=session();if(current!==active){unsubSession?.();active=current;unsubSession=current?.subscribe(update);}buttons.get('undo')!.disabled=!current?.canUndo;buttons.get('redo')!.disabled=!current?.canRedo;
    status.textContent=s.tool==='text'?'Type':s.mouseDrawing?'Mouse + Pencil':'Pencil';};
  const unsubscribe=host.subscribeSettings(update);update();const timer=window.setInterval(update,900);
  const editor=container.closest<HTMLElement>('.cm-editor');const resize=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>{editor?.style.setProperty('--inkspace-toolbar-height',`${bar.getBoundingClientRect().height}px`);}):null;resize?.observe(bar);
  return()=>{window.clearInterval(timer);resize?.disconnect();editor?.style.removeProperty('--inkspace-toolbar-height');unsubscribe();unsubSession?.();bar.remove();};
}
