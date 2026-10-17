import { InkModel, assertDocumentLimits, createDocument, validateDocument, reconcileAnchors } from './core';
import type { InkDocument, InkSession } from './types';

export interface StorageIO {
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
  remove?(path: string): Promise<void>;
  /** Recursively list file paths beneath a folder; used to move unopened notes too. */
  list?(folder: string): Promise<string[]>;
}
interface RecordState { path: string; model: InkModel; session: InkSession; baseline: string | null; base: InkDocument; saving: boolean; redirect?: RecordState; transition?: Promise<void>; listeners: Set<() => void> }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const resolve = (record: RecordState): RecordState => { while (record.redirect) record = record.redirect; return record; };
export function sidecarPath(folder: string, path: string): string {
  if (!folder || folder.startsWith('/') || /[\\:]/.test(folder+path) || folder.split('/').some(s=>s==='..') || path.startsWith('/') || path.split('/').some(s=>s==='..')) throw new Error('Invalid ink storage path.');
  return `${folder.replace(/\/+$/, '')}/${path}.ink.json`;
}
/** Three-way merge honors independent changes and deletion; same-stroke conflicts retain both complete documents on disk. */
export function mergeInk(base: InkDocument, local: InkDocument, remote: InkDocument): {document: InkDocument; conflict: boolean} {
  base={...base,strokes:reconcileAnchors(base.strokes,local.sourceText)};
  remote={...remote,strokes:reconcileAnchors(remote.strokes,local.sourceText)};
  const b = new Map(base.strokes.map(s=>[s.id,s])); const l = new Map(local.strokes.map(s=>[s.id,s])); const r = new Map(remote.strokes.map(s=>[s.id,s]));
  let conflict = false;
  const strokes: InkDocument['strokes'] = [];
  for (const id of new Set([...b.keys(),...l.keys(),...r.keys()])) {
    const bs=b.get(id), ls=l.get(id), rs=r.get(id);
    const equal=(a:unknown,c:unknown)=>JSON.stringify(a)===JSON.stringify(c);
    let chosen;
    if (equal(ls,rs)) chosen=ls; else if(equal(ls,bs)) chosen=rs; else if(equal(rs,bs)) chosen=ls;
    else { conflict=true; chosen=ls; }
    if(chosen) strokes.push(clone(chosen));
  }
  return {document:{...clone(local),strokes,revision:Math.max(local.revision,remote.revision)+1,updatedAt:Date.now()},conflict};
}
export class InkStore {
  private records = new Map<string,RecordState>();
  private lifecycle: Promise<void> = Promise.resolve();
  constructor(private io:StorageIO, private folder:()=>string, private notify:(message:string,error?:boolean)=>void) {}
  private sequence<T>(action: () => Promise<T>): Promise<T> {
    const task = this.lifecycle.then(action);
    this.lifecycle = task.then(() => {}, () => {});
    return task;
  }
  get(path:string,text=''):Promise<InkSession> {
    // File-open can run during the same rename event. It must see the migrated
    // session, rather than permanently caching a missing target sidecar.
    return this.sequence(async () => this.records.get(path)?.session ?? await this.load(path,text));
  }
  private async load(path:string,text:string):Promise<InkSession> {
    const raw=await this.io.read(sidecarPath(this.folder(),path));
    let doc=createDocument(path,text);
    if(raw!==null) {
      try {doc=validateDocument(JSON.parse(raw),path);} catch(error) {
        // Never replace a corrupt or future-format file with an empty document.
        throw new Error(`Ink could not be opened. The original data was preserved. ${String(error)}`);
      }
    }
    const record=this.createRecord(path,doc,raw);
    const model=record.model;
    if(path.toLowerCase().endsWith('.md')) model.reconcileText(text);
    return record.session;
  }
  private createRecord(path: string, doc: InkDocument, raw: string | null): RecordState {
    const record = {} as RecordState;
    const model = new InkModel(doc, async snapshot => this.persist(record, snapshot), error => this.notify(`Ink save failed: ${String(error)}. Use Save ink to retry.`, true));
    // Stable facades let already-open editors follow a rename without replacing
    // their session, subscriptions, or undo history. A pre-opened target facade
    // can be redirected to the same record after migration.
    const session: InkSession = {
      get path() { return resolve(record).path; },
      get document() { const current = resolve(record); const document = current.model.document; return document.notePath === current.path ? document : { ...document, notePath: current.path }; },
      get canUndo() { return resolve(record).model.canUndo; }, get canRedo() { return resolve(record).model.canRedo; },
      add: strokes => resolve(record).model.add(strokes),
      replace: (strokes,label) => resolve(record).model.replace(strokes,label),
      undo: () => resolve(record).model.undo(), redo: () => resolve(record).model.redo(),
      updateText: (changes,text) => resolve(record).model.updateText(changes,text),
      reconcileText: text => resolve(record).model.reconcileText(text),
      subscribe: listener => { resolve(record).listeners.add(listener); return () => resolve(record).listeners.delete(listener); },
      flush: () => resolve(record).model.flush(),
    };
    Object.assign(record, { path, model, session, baseline: raw, base: clone(doc), saving: false, listeners: new Set<() => void>() });
    model.subscribe(() => this.emit(resolve(record)));
    this.records.set(path, record);
    return record;
  }
  private emit(record: RecordState): void { for (const listener of record.listeners) listener(); }
  private backupPath(path: string, kind: string): string { return `${path}.${kind}-${Date.now()}-${Math.random().toString(36).slice(2,9)}.json`; }
  private document(record: RecordState): InkDocument { return { ...clone(record.model.document), notePath: record.path }; }
  private async awaitTransition(record: RecordState): Promise<RecordState> {
    let current = resolve(record);
    while (current.transition) { await current.transition; current = resolve(current); }
    return current;
  }
  private async persist(record:RecordState,snapshot:InkDocument):Promise<void> {
    const original = record;
    record = await this.awaitTransition(record);
    // A target session opened before a rename may already have an autosave
    // waiting at the gate. Its live edits were merged into the canonical model;
    // saving its abandoned snapshot would overwrite that combined document.
    if (record !== original) return;
    snapshot = { ...snapshot, notePath: record.path };
    const path=sidecarPath(this.folder(),snapshot.notePath); record.saving=true;
    try {
      const current=await this.io.read(path); let output=clone(snapshot);
      if(current!==record.baseline && current!==null) {
        let remote:InkDocument;
        try {remote=validateDocument(JSON.parse(current),snapshot.notePath);} catch {
          throw new Error('The ink file changed to unreadable data. Save stopped to preserve it.');
        }
        const merged=mergeInk(record.base,snapshot,remote); output=merged.document;
        if(merged.conflict) {
          const backup=`${path}.conflict-${Date.now()}-${Math.random().toString(36).slice(2,7)}.json`;
          await this.io.write(backup,current);
          this.notify(`Ink sync conflict: both versions were kept. Incoming copy: ${backup}`,true);
        }
      } else if(current===null && record.baseline!==null) {
        // A remote deletion is meaningful. Keep pending local work as a recovery copy.
        const recovery=`${path}.recovered-${Date.now()}.json`;
        await this.io.write(recovery,JSON.stringify(output));
        throw new Error(`Ink data was removed on another device. Pending work was kept at ${recovery}.`);
      }
      assertDocumentLimits(output);
      const encoded=JSON.stringify(output); await this.io.write(path,encoded);
      record.baseline=encoded; record.base=clone(output);
      // Independent remote strokes can be merged after the current write without dropping newer local work.
      const live=record.model.document;
      const mergedLive=mergeInk(snapshot,live,output).document;
      if(JSON.stringify(mergedLive.strokes)!==JSON.stringify(live.strokes)) record.model.replace(mergedLive.strokes,'Merge synced ink');
    } finally {record.saving=false;}
  }
  refresh(path:string):Promise<void> { return this.sequence(() => this.refreshRecord(path)); }
  private async refreshRecord(path:string):Promise<void> {
    const record=this.records.get(path); if(!record||record.saving)return;
    await record.model.flush();
    const baseline=record.baseline, base=clone(record.base);
    const raw=await this.io.read(sidecarPath(this.folder(),path));
    // A save completed while the read was pending. Its baseline is newer than
    // this read and it already merged the disk contents; never roll it back.
    if(record.baseline!==baseline)return;
    if(raw===record.baseline||raw===null)return;
    const doc=validateDocument(JSON.parse(raw),path);
    let merged=mergeInk(base,this.document(record),doc);
    if(merged.conflict) {
      const backup=this.backupPath(sidecarPath(this.folder(),path),'conflict');
      await this.io.write(backup,raw);
      this.notify(`Ink sync conflict: both versions were kept. Incoming copy: ${backup}`,true);
      if(record.baseline!==baseline)return;
      // Writing a conflict copy is asynchronous too. Include any additional
      // typing, drawing, or erasing received during that write.
      merged=mergeInk(base,this.document(record),doc);
    }
    record.baseline=raw; record.base=clone(doc);
    if(JSON.stringify(merged.document.strokes)!==JSON.stringify(record.model.document.strokes)) record.model.replace(merged.document.strokes,'Load synced ink');
  }
  flushAll():Promise<void> { return this.sequence(async () => { await Promise.all([...this.records.values()].map(record=>record.model.flush())); }); }
  rename(oldPath:string,newPath:string):Promise<void> { return this.sequence(() => this.renameRecord(oldPath,newPath)); }
  renameFolder(oldFolder: string, newFolder: string): Promise<void> {
    return this.sequence(async () => {
      sidecarPath(this.folder(), `${oldFolder}/check.md`); sidecarPath(this.folder(), `${newFolder}/check.md`);
      if (oldFolder === newFolder) return;
      if (newFolder.startsWith(`${oldFolder}/`)) throw new Error('Cannot move an ink folder inside itself.');
      const paths = new Set([...this.records.keys()].filter(path => path.startsWith(`${oldFolder}/`)));
      if (!this.io.list) throw new Error('Folder annotation migration requires recursive storage listing. Original ink data was preserved.');
      const prefix = `${this.folder().replace(/\/+$/, '')}/`;
      for (const file of await this.io.list(`${prefix}${oldFolder}`)) {
        if (file.startsWith(`${prefix}${oldFolder}/`) && file.endsWith('.ink.json')) paths.add(file.slice(prefix.length, -'.ink.json'.length));
      }
      const errors: string[] = [];
      for (const path of [...paths].sort()) {
        try { await this.renameRecord(path, `${newFolder}${path.slice(oldFolder.length)}`); }
        catch (error) { errors.push(`${path}: ${String(error)}`); }
      }
      if (errors.length) throw new Error(`Some folder annotations need recovery. ${errors.join(' ')}`);
    });
  }
  private async renameRecord(oldPath:string,newPath:string):Promise<void> {
    if (oldPath === newPath) return;
    const oldFile = sidecarPath(this.folder(),oldPath), newFile = sidecarPath(this.folder(),newPath);
    let record = this.records.get(oldPath);
    const target = this.records.get(newPath);
    // Finish saves begun before the rename, then block new saves until the
    // sidecar and canonical path agree. Drawing itself can continue throughout.
    await Promise.all([record?.model.flush(), target?.model.flush()]);
    let release!: () => void;
    const transition = new Promise<void>(done => { release = done; });
    if (record) record.transition = transition;
    if (target) target.transition = transition;
    let canonical: RecordState | undefined;
    let liveConflictBackup: { path: string; data: string } | null = null;
    try {
      const raw = await this.io.read(oldFile);
      if (!record && raw === null) return;
      if (!record) record = this.createRecord(oldPath, validateDocument(JSON.parse(raw!),oldPath),raw);
      canonical = record;
      canonical.transition = transition;
      const incoming = await this.io.read(newFile);
      const originalDocument = this.document(canonical);
      const originalTarget = target ? this.document(target) : null;
      let targetDocument: InkDocument | null = null;
      if (incoming !== null) targetDocument = validateDocument(JSON.parse(incoming),newPath);
      if (target) {
        targetDocument = originalTarget;
        if (incoming !== null && incoming !== target.baseline) targetDocument = mergeInk(target.base,originalTarget!,validateDocument(JSON.parse(incoming),newPath)).document;
      }
      let output = originalDocument;
      if (raw !== null && raw !== canonical.baseline) output = mergeInk(canonical.base,output,validateDocument(JSON.parse(raw),oldPath)).document;
      output.notePath = newPath;
      if (targetDocument?.strokes.length) {
        const merged = mergeInk(createDocument(newPath,output.sourceText),output,{...targetDocument,notePath:newPath});
        output = merged.document;
        if (merged.conflict) this.notify('Overlapping annotation versions were kept in rename recovery files.',true);
      }
      output.revision++;
      output.updatedAt = Date.now();
      assertDocumentLimits(output);
      // Both active documents are copied before either can be replaced. The
      // original path ceases to contain active ink, so reusing it starts clean.
      let recovery: string | null = null;
      if (raw !== null) { recovery = this.backupPath(oldFile,'renamed-backup'); await this.io.write(recovery,raw); }
      if (incoming !== null) await this.io.write(this.backupPath(newFile,'rename-target-backup'),incoming);
      const needsFile = raw !== null || incoming !== null || output.strokes.length > 0;
      const encoded = needsFile ? JSON.stringify(output) : null;
      if (encoded !== null) await this.io.write(newFile,encoded);
      if (raw !== null) {
        let removed = false;
        if (this.io.remove) { try { await this.io.remove(oldFile); removed = true; } catch { /* Safely retire it with a tombstone below. */ } }
        if (!removed) {
          const tombstone={...createDocument(oldPath),renamedTo:newPath,recovery};
          assertDocumentLimits(tombstone);
          await this.io.write(oldFile,JSON.stringify(tombstone));
        }
      }
      // While storage awaited, either of the already-open editors may have
      // received more writing or erasing. Rebase both deltas onto the migrated
      // snapshot before redirecting the target facade.
      let liveOutput = mergeInk(originalDocument,this.document(canonical),output).document;
      if (target && originalTarget) {
        const changedTarget = this.document(target);
        const mergedLive = mergeInk(originalTarget,liveOutput,changedTarget);
        liveOutput = mergedLive.document;
        if (mergedLive.conflict) liveConflictBackup = { path: this.backupPath(newFile,'rename-live-conflict'), data: JSON.stringify(changedTarget) };
      }
      canonical.path = newPath; canonical.baseline = encoded; canonical.base = clone(output);
      this.records.delete(oldPath); this.records.set(newPath,canonical);
      if (target && target !== canonical) {
        for (const listener of target.listeners) canonical.listeners.add(listener);
        target.listeners.clear(); target.redirect = canonical;
      }
      if (JSON.stringify(liveOutput.strokes) !== JSON.stringify(canonical.model.document.strokes)) canonical.model.replace(liveOutput.strokes,'Merge annotations after rename');
      this.emit(canonical);
    } finally {
      if (record) record.transition = undefined;
      if (target) target.transition = undefined;
      release();
    }
    if (liveConflictBackup) await this.io.write(liveConflictBackup.path,liveConflictBackup.data);
    // Complete any new writing received during the move before reporting that
    // the rename finished. A pending save resumes only after the gate opens.
    await canonical?.model.flush();
  }
}
