import {EditorState} from '@codemirror/state';
import {EditorView,keymap} from '@codemirror/view';
import {history,defaultKeymap,historyKeymap} from '@codemirror/commands';
import {markdown} from '@codemirror/lang-markdown';
import {inkspaceExtension} from '../src/editor';
import {InkStore} from '../src/store';
import {createToolbar} from '../src/toolbar';
import {normalizeFavoriteStyles} from '../src/presets';
import {DEFAULT_SETTINGS,type InkHost,type InkSettings} from '../src/types';
const welcome='# A little room to think\n\nYour words and handwriting belong together.\n\nOpen an ordinary note. Keep typing, and use the pen to mark what matters.\n\nCircle an idea. Highlight a sentence. Draw a connection.\n\nThe text stays editable underneath your annotations.\n\n## One surface, every thought\n\nUse the colored pen to write anywhere on this page.\nChoose the highlighter to emphasize existing text.\nUse the lasso to move or copy your handwriting.\n\nYour keyboard keeps working while the Pencil is ready.\n\n## Built to keep your notes yours\n\nInk is stored as editable vectors beside your Markdown.\n\n\n\n\n\n\n\n\n\n';
const notes:Record<string,string>={'Welcome.md':welcome,'Study.md':'# Study notes\n\nA clear explanation starts with a good question.\n\nConnect the cause to the effect.\n\nAdd your explanation here.\n\n\n\n\n\n','Blank.md':'# A new thought\n\n\n\n\n\n\n\n\n\n\n\n'};
function loadPreferences(): InkSettings {
  let saved: Partial<InkSettings> = {};
  try { saved = JSON.parse(localStorage.getItem('inkspace:settings') ?? '{}') ?? {}; } catch { /* Start with defaults if preview preferences are invalid. */ }
  return { ...DEFAULT_SETTINGS, mouseDrawing: true, ...saved, stabilization: ['off','light','natural','strong'].includes(saved.stabilization ?? '') ? saved.stabilization! : DEFAULT_SETTINGS.stabilization, favoriteStyles: normalizeFavoriteStyles(saved.favoriteStyles) };
}
let path='Welcome.md';let preferences:InkSettings=loadPreferences();const listeners=new Set<()=>void>();
const status=(message:string,error=false)=>{const s=document.querySelector<HTMLElement>('#status')!;s.textContent=message;s.style.display='block';s.style.background=error?'#992f38':'#233653';setTimeout(()=>s.style.display='none',4000);};
const store=new InkStore({read:async name=>localStorage.getItem(name),write:async(name,data)=>{localStorage.setItem(name,data);document.querySelector('#footer-state')!.textContent='All ink saved on this device';}},()=>preferences.dataFolder,status);
const host:InkHost={getSettings:()=>preferences,updateSettings:patch=>{preferences={...preferences,...patch};localStorage.setItem('inkspace:settings',JSON.stringify(preferences));for(const listener of listeners)listener();},subscribeSettings:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},getSession:async name=>store.get(name,notes[name]??''),resolveEditor:()=>({path,title:path}),status,toolbar:(container,session,extra)=>createToolbar(host,container,session,extra)};
const makeState=()=>EditorState.create({doc:localStorage.getItem(`text:${path}`)??notes[path],extensions:[history(),keymap.of([...defaultKeymap,...historyKeymap]),markdown(),EditorView.lineWrapping,inkspaceExtension(host),EditorView.updateListener.of(update=>{if(update.docChanged){notes[path]=update.state.doc.toString();localStorage.setItem(`text:${path}`,notes[path]);}})]});
const view=new EditorView({state:makeState(),parent:document.querySelector('#editor')!});
for(const button of document.querySelectorAll<HTMLButtonElement>('.note-link'))button.onclick=()=>{path=button.dataset.path!;view.setState(makeState());document.querySelector('#note-title')!.textContent=path.replace('.md','');document.querySelectorAll('.note-link').forEach(b=>b.classList.toggle('active',b===button));};
(window as unknown as {inkspaceTest:unknown}).inkspaceTest={host,view,getSession:()=>host.getSession(path),get path(){return path;},store};
window.addEventListener('pagehide',()=>void store.flushAll());
