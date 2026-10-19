import { Plugin, PluginSettingTab, Setting, Notice, Modal, MarkdownView, TFile, TFolder, normalizePath, type App } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { inkspaceExtension, refreshInkspaceEditors } from './editor';
import { InkStore } from './store';
import { validateDocument, reconcileAnchors } from './core';
import { createToolbar } from './toolbar';
import { normalizeFavoriteStyles } from './presets';
import { DEFAULT_SETTINGS, type InkHost, type InkSettings, type InkSession, type ToolbarActions } from './types';
import { InkspacePdfView, VIEW_TYPE_PDF } from './pdf';
import { importGoodnotesFiles } from './importer';

export default class InkspacePlugin extends Plugin implements InkHost {
  private preferences:InkSettings={...DEFAULT_SETTINGS}; private listeners=new Set<()=>void>(); private store!:InkStore; private saveSettingsTimer:number|undefined;
  async onload():Promise<void> {
    const saved=await this.loadData();this.preferences={...DEFAULT_SETTINGS,...saved};this.sanitizeSettings();
    const ensureFolder=async(path:string)=>{let current='';for(const part of normalizePath(path).split('/')){current=current?`${current}/${part}`:part;if(current&&!await this.app.vault.adapter.exists(current)){try{await this.app.vault.createFolder(current);}catch(e){if(!await this.app.vault.adapter.exists(current))throw e;}}}};
    this.store=new InkStore({
      read:async path=>await this.app.vault.adapter.exists(path)?await this.app.vault.adapter.read(path):null,
      write:async(path,data)=>{await ensureFolder(path.substring(0,path.lastIndexOf('/')));const f=this.app.vault.getAbstractFileByPath(path);if(f instanceof TFile)await this.app.vault.modify(f,data);else if(await this.app.vault.adapter.exists(path))await this.app.vault.adapter.write(path,data);else await this.app.vault.create(path,data);},
      remove:async path=>{const file=this.app.vault.getAbstractFileByPath(path);if(file instanceof TFile)await this.app.vault.delete(file);else if(await this.app.vault.adapter.exists(path))await this.app.vault.adapter.remove(path);},
      list:async prefix=>{const files:string[]=[];const queue=[prefix];while(queue.length){const folder=queue.shift()!;if(!await this.app.vault.adapter.exists(folder))continue;const listing=await this.app.vault.adapter.list(folder);files.push(...listing.files);queue.push(...listing.folders);}return files;}
    },()=>this.preferences.dataFolder,(message,error)=>this.status(message,error));
    this.registerEditorExtension(inkspaceExtension(this));
    this.registerEvent(this.app.workspace.on('file-open',()=>refreshInkspaceEditors(this)));
    this.registerEvent(this.app.workspace.on('layout-change',()=>refreshInkspaceEditors(this)));
    this.registerView(VIEW_TYPE_PDF,leaf=>new InkspacePdfView(leaf,this));
    this.addSettingTab(new InkspaceSettings(this.app,this));
    this.addRibbonIcon('pen-tool','Inkspace tools',()=>this.updateSettings({enabled:!this.preferences.enabled}));
    this.addCommand({id:'toggle-tools',name:'Toggle writing tools',callback:()=>this.updateSettings({enabled:!this.preferences.enabled})});
    this.addCommand({id:'type',name:'Type and select text',callback:()=>this.updateSettings({tool:'text',enabled:true})});
    this.addCommand({id:'pen',name:'Write with pen',callback:()=>this.updateSettings({tool:'pen',enabled:true})});
    this.addCommand({id:'mouse',name:'Toggle drawing with mouse',callback:()=>this.updateSettings({mouseDrawing:!this.preferences.mouseDrawing})});
    this.addCommand({id:'save',name:'Save all ink now',callback:()=>void this.store.flushAll().then(()=>this.status('All ink saved.')).catch(e=>this.status(String(e),true))});
    this.addCommand({id:'new-note',name:'Create a writing note',callback:()=>void this.createNote()});
    this.addCommand({id:'insert-space',name:'Insert writing space below cursor',editorCallback:editor=>{const cursor=editor.getCursor();editor.replaceRange('\n'.repeat(8),{line:cursor.line,ch:editor.getLine(cursor.line).length});}});
    this.addCommand({id:'import-goodnotes',name:'Import Goodnotes PDF or ZIP export',callback:()=>this.pickImport()});
    this.addCommand({id:'open-pdf',name:'Annotate current PDF',checkCallback:checking=>{const file=this.app.workspace.getActiveFile();if(file?.extension!=='pdf')return false;if(!checking)void this.openPdf(file);return true;}});
    this.addCommand({id:'help',name:'Getting started',callback:()=>new HelpModal(this.app).open()});
    this.addCommand({id:'restore-ink',name:'Restore ink from a recovery file',callback:()=>new RecoveryModal(this.app,this).open()});
    this.registerEvent(this.app.workspace.on('file-menu',(menu,file)=>{if(file instanceof TFile&&file.extension==='pdf')menu.addItem(item=>item.setTitle('Annotate with Inkspace').setIcon('pen-tool').onClick(()=>void this.openPdf(file)));}));
    this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{if(oldPath.startsWith(`${this.preferences.dataFolder}/`)||oldPath===this.preferences.dataFolder)return;const task=file instanceof TFile?this.store.rename(oldPath,file.path):file instanceof TFolder?this.store.renameFolder(oldPath,file.path):Promise.resolve();void task.then(()=>refreshInkspaceEditors(this)).catch(e=>this.status(String(e),true));}));
    this.registerEvent(this.app.workspace.on('active-leaf-change',()=>{const path=this.app.workspace.getActiveFile()?.path;if(path)void this.store.refresh(path).catch(e=>this.status(String(e),true));}));
    this.registerEvent(this.app.vault.on('modify',file=>{const prefix=`${this.preferences.dataFolder}/`;if(file.path.startsWith(prefix)&&file.path.endsWith('.ink.json')){const source=file.path.slice(prefix.length,-'.ink.json'.length);void this.store.refresh(source).catch(e=>this.status(String(e),true));}}));
    this.registerDomEvent(document,'visibilitychange',()=>{if(document.visibilityState==='hidden')void this.store.flushAll().catch(e=>this.status(String(e),true));});
    this.registerDomEvent(window,'pagehide',()=>{void this.store.flushAll().catch(e=>this.status(String(e),true));});
  }
  onunload():void {if(this.saveSettingsTimer)window.clearTimeout(this.saveSettingsTimer);void this.store?.flushAll().catch(e=>console.error('Inkspace final save failed',e));this.listeners.clear();}
  getSettings():InkSettings{return this.preferences;}
  updateSettings(patch:Partial<InkSettings>):void {this.preferences={...this.preferences,...patch};this.sanitizeSettings();for(const listener of this.listeners)listener();if(this.saveSettingsTimer)window.clearTimeout(this.saveSettingsTimer);this.saveSettingsTimer=window.setTimeout(()=>void this.saveData(this.preferences).catch(e=>this.status(`Settings could not be saved: ${String(e)}`,true)),250);}
  private sanitizeSettings():void {
    const s=this.preferences;const numeric=(n:unknown,min:number,max:number,fallback:number)=>typeof n==='number'&&Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;
    s.favoriteStyles=normalizeFavoriteStyles(s.favoriteStyles);
    s.zoom=numeric(s.zoom,.4,2,1);s.penWidth=numeric(s.penWidth,0.5,32,2.5);s.highlighterWidth=numeric(s.highlighterWidth,2,64,22);s.eraserSize=numeric(s.eraserSize,2,100,18);s.smoothing=numeric(s.smoothing,0,1,.55);s.highlighterOpacity=numeric(s.highlighterOpacity,.05,.65,.27);s.writingWidth=numeric(s.writingWidth,400,1400,760);
    if(!/^#[0-9a-f]{6}$/i.test(s.color))s.color=DEFAULT_SETTINGS.color;
    if(!['pen','highlighter','eraser','lasso','text','line','arrow','rectangle','ellipse'].includes(s.tool))s.tool='pen';
    if(!['plain','ruled','grid','dots'].includes(s.paper))s.paper='plain';
    if(typeof s.dataFolder!=='string'||!s.dataFolder.trim()||s.dataFolder.startsWith('.')||s.dataFolder.includes('..')||/[\\:*?"<>|]/.test(s.dataFolder))s.dataFolder=DEFAULT_SETTINGS.dataFolder;
  }
  subscribeSettings(listener:()=>void):()=>void {this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  async getSession(path:string):Promise<InkSession>{const file=this.app.vault.getAbstractFileByPath(path);const text=file instanceof TFile&&file.extension==='md'?await this.app.vault.cachedRead(file):'';return this.store.get(path,text);}
  resolveEditor(editor:EditorView):{path:string;title:string}|null {
    let found:{path:string;title:string}|null=null;this.app.workspace.iterateAllLeaves(leaf=>{const view=leaf.view;if(view instanceof MarkdownView&&view.file&&view.containerEl.contains(editor.dom))found={path:view.file.path,title:view.file.basename};});return found;
  }
  toolbar(container:HTMLElement,session:()=>InkSession|null,extra?:ToolbarActions):()=>void{return createToolbar(this,container,session,extra);}
  status(message:string,error=false):void {new Notice(message,error?12000:3500);}
  async openPdf(file:TFile):Promise<void>{const leaf=this.app.workspace.getLeaf('tab');await leaf.setViewState({type:VIEW_TYPE_PDF,state:{file:file.path},active:true});await this.app.workspace.revealLeaf(leaf);}
  private async createNote():Promise<void>{try{const stamp=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);const file=await this.app.vault.create(`Inkspace ${stamp}.md`,'# New note\n\nType here, or write anywhere on this page with your Pencil.\n\n\n\n\n\n');await this.app.workspace.getLeaf('tab').openFile(file);this.updateSettings({enabled:true,tool:'pen'});}catch(e){this.status(String(e),true);}}
  private pickImport():void {
    const input=document.createElement('input');input.type='file';input.multiple=true;input.accept='.pdf,.zip,.png,.jpg,.jpeg,.goodnotes';input.style.display='none';document.body.append(input);
    input.onchange=async()=>{const files=Array.from(input.files??[]);input.remove();if(!files.length)return;this.status('Importing exported notes…');try{const result=await importGoodnotesFiles(this.app,files);new ImportReportModal(this.app,result).open();const index=result.imported.find(p=>p.endsWith('Import index.md'));const f=index?this.app.vault.getAbstractFileByPath(index):null;if(f instanceof TFile)await this.app.workspace.getLeaf('tab').openFile(f);}catch(e){this.status(`Import failed: ${String(e)}`,true);}};
    input.addEventListener('cancel',()=>input.remove(),{once:true});input.click();
  }
}

class InkspaceSettings extends PluginSettingTab {
  constructor(app:App,private plugin:InkspacePlugin){super(app,plugin);}
  display():void {this.containerEl.empty();this.containerEl.createEl('h2',{text:'Inkspace'});this.containerEl.createEl('p',{text:'Pencil draws directly on your notes. Your keyboard and normal mouse selection remain available.'});
    const toggle=(name:string,description:string,key:'enabled'|'mouseDrawing'|'stableLayout'|'usePressure')=>new Setting(this.containerEl).setName(name).setDesc(description).addToggle(t=>t.setValue(this.plugin.getSettings()[key]).onChange(v=>this.plugin.updateSettings({[key]:v})));
    toggle('Show writing tools','Show the compact ink toolbar in Markdown notes.','enabled');toggle('Draw with mouse','Use a mouse to draw on Windows. Turn off for normal text selection.','mouseDrawing');toggle('Consistent writing width','Reduces changes in wrapping across devices. Reposition freehand ink after major layout changes.','stableLayout');toggle('Pressure-sensitive pen','Use pressure on supported pens. USB-C Apple Pencil uses the selected thickness.','usePressure');
    new Setting(this.containerEl).setName('Writing width').setDesc('Document width in pixels. Keep the same value on your devices.').addSlider(s=>s.setLimits(400,1200,20).setValue(this.plugin.getSettings().writingWidth).setDynamicTooltip().onChange(v=>this.plugin.updateSettings({writingWidth:v})));
    new Setting(this.containerEl).setName('Stroke smoothing').addSlider(s=>s.setLimits(0,1,.05).setValue(this.plugin.getSettings().smoothing).setDynamicTooltip().onChange(v=>this.plugin.updateSettings({smoothing:v})));
    new Setting(this.containerEl).setName('Highlighter opacity').addSlider(s=>s.setLimits(.1,.6,.05).setValue(this.plugin.getSettings().highlighterOpacity).setDynamicTooltip().onChange(v=>this.plugin.updateSettings({highlighterOpacity:v})));
    this.containerEl.createEl('h3',{text:'Across your devices'});this.containerEl.createEl('p',{text:'Include the “Inkspace Data” folder in your vault sync. With Obsidian Sync, enable “Sync all other types” on every device. Keep the same plugin version on both devices.'});
    new Setting(this.containerEl).setName('Getting started and iPad setup').addButton(b=>b.setButtonText('Open guide').onClick(()=>new HelpModal(this.app).open()));
  }
}
class HelpModal extends Modal {
  onOpen():void {this.titleEl.setText('Write directly on your notes');const c=this.contentEl;c.createEl('p',{text:'Open an ordinary Markdown note in editing / Live Preview mode. Pick a color and write over the text with Apple Pencil. Fingers scroll; your keyboard keeps typing.'});
    c.createEl('p',{text:'On Windows, use a pen display or enable the target-shaped “Draw with mouse” button. Choose Aa for text selection and caret placement when needed.'});
    c.createEl('p',{text:'On iPad, disable Apple Pencil Scribble if iPadOS intercepts writing or scratch-out gestures. Test with your palm resting naturally before using important notes.'});
    c.createEl('p',{text:'Ink follows its anchored line when you insert text above it. Substantial rewriting, line wrapping, folded sections, and layout changes can require moving ink with the lasso. Ink attached to deleted text is kept for recovery.'});
    c.createEl('p',{text:'Open a PDF, then run “Inkspace: Annotate current PDF”. Use the import command for Goodnotes-exported PDFs or ZIP folders. Proprietary .goodnotes files must first be exported from Goodnotes.'});
    c.createEl('p',{text:'This is an early prototype. Desktop tests do not verify Apple Pencil latency or palm rejection on a physical iPad. Keep your source notes and Goodnotes backups.'});}
}
class ImportReportModal extends Modal {constructor(app:App,private report:{imported:string[];skipped:string[]}){super(app);}onOpen():void{this.titleEl.setText('Import complete');this.contentEl.createEl('p',{text:`${this.report.imported.length} files created.`});if(this.report.skipped.length){this.contentEl.createEl('p',{text:'Items needing attention:'});const list=this.contentEl.createEl('ul');for(const text of this.report.skipped)list.createEl('li',{text});}}}
class RecoveryModal extends Modal {
  constructor(app:App,private plugin:InkspacePlugin){super(app);}
  onOpen():void {this.titleEl.setText('Restore an ink recovery copy');const files=this.app.vault.getFiles().filter(f=>f.path.startsWith(`${this.plugin.getSettings().dataFolder}/`)&&/\.(?:conflict|recovered|renamed-backup|rename-target-backup|rename-live-conflict|restore-backup)-.*\.json$/.test(f.path));if(!files.length){this.contentEl.createEl('p',{text:'No recovery files were found.'});return;}
    for(const file of files)new Setting(this.contentEl).setName(file.name).addButton(b=>b.setButtonText('Choose target…').onClick(async()=>{try{const raw=JSON.parse(await this.app.vault.read(file));const doc=validateDocument(raw,raw.notePath);new RestoreTargetModal(this.app,this.plugin,doc).open();this.close();}catch(e){this.plugin.status(String(e),true);}}));
  }
}
class RestoreTargetModal extends Modal {
  constructor(app:App,private plugin:InkspacePlugin,private document:import('./types').InkDocument){super(app);}
  onOpen():void {
    this.titleEl.setText('Choose where to restore the ink');
    const pdf=this.document.notePath.toLowerCase().endsWith('.pdf');
    const files=this.app.vault.getFiles().filter(file=>file.extension===(pdf?'pdf':'md')).sort((a,b)=>a.path.localeCompare(b.path));
    if(!files.length){this.contentEl.createEl('p',{text:`Create or open a ${pdf?'PDF':'Markdown'} target note first. The recovery file has been kept.`});return;}
    const original=files.find(file=>file.path===this.document.notePath);const active=this.app.workspace.getActiveFile();let target=original?.path??files.find(file=>file.path===active?.path)?.path??files[0].path;
    this.contentEl.createEl('p',{text:`Original source: ${this.document.notePath}. Choose an existing target; renamed sources are not recreated automatically.`});
    new Setting(this.contentEl).setName('Target note').addDropdown(dropdown=>{for(const file of files)dropdown.addOption(file.path,file.path);dropdown.setValue(target).onChange(value=>target=value);});
    this.contentEl.createEl('p',{text:'Restoring replaces the target’s current ink. A recovery copy of its current ink will be kept.'});
    new Setting(this.contentEl).addButton(button=>button.setButtonText('Restore to this note').setCta().onClick(async()=>{
      button.setDisabled(true);
      try {
        const file=this.app.vault.getAbstractFileByPath(target);if(!(file instanceof TFile))throw new Error('The selected target no longer exists.');
        const session=await this.plugin.getSession(target);await session.flush();
        if(session.document.strokes.length){const backup=normalizePath(`${this.plugin.getSettings().dataFolder}/${target}.ink.json.restore-backup-${Date.now()}-${Math.random().toString(36).slice(2,7)}.json`);await this.app.vault.create(backup,JSON.stringify({...session.document,notePath:target}));}
        const strokes=pdf?this.document.strokes:reconcileAnchors(this.document.strokes,session.document.sourceText);
        session.replace(strokes,'Restore recovery');await session.flush();this.plugin.status('Ink restored to the selected note. Recovery copies were kept.');this.close();
      }catch(error){this.plugin.status(String(error),true);button.setDisabled(false);}
    }));
  }
}

