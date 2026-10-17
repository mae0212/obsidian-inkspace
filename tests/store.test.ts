import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnchor, createDocument, validateDocument } from '../src/core';
import { InkStore, mergeInk, sidecarPath, type StorageIO } from '../src/store';
import type { InkDocument, Stroke } from '../src/types';

const note = 'Lecture.md', file = sidecarPath('Inkspace Data', note);
const mark = (id: string, patch: Partial<Stroke> = {}): Stroke => ({ id, tool: 'pen', points: [{ x: 10, y: 20, pressure: .5 }], color: '#2563eb', width: 3, opacity: 1, updatedAt: 1, ...patch });
const doc = (strokes: Stroke[], text = ''): InkDocument => ({ ...createDocument(note, text), updatedAt: 1, strokes });
const ids = (d: InkDocument) => d.strokes.map(s => s.id).sort();
class MemoryIO implements StorageIO {
  files = new Map<string, string>(); writes: { path: string; data: string }[] = []; reads = 0;
  beforeWrite?: (path: string, data: string) => Promise<void>;
  beforeRead?: (path: string) => Promise<void>;
  async read(path: string): Promise<string | null> { this.reads++; const snapshot=this.files.get(path) ?? null; await this.beforeRead?.(path); return snapshot; }
  async write(path: string, data: string): Promise<void> { await this.beforeWrite?.(path, data); this.writes.push({ path, data }); this.files.set(path, data); }
  async remove(path: string): Promise<void> { this.files.delete(path); }
  async list(folder: string): Promise<string[]> { return [...this.files.keys()].filter(path => path.startsWith(`${folder}/`)); }
}
function fixture(base: InkDocument) {
  const io = new MemoryIO(); io.files.set(file, JSON.stringify(base));
  const notices: string[] = [];
  const store = new InkStore(io, () => 'Inkspace Data', text => { notices.push(text); });
  return { io, store, notices };
}

test('three-way merge honors stroke deletion and combines independent additions', () => {
  const a = mark('A'), b = mark('B'), c = mark('C');
  const base = doc([a]);
  const merged = mergeInk(base, doc([a, b]), doc([a, c]));
  assert.equal(merged.conflict, false);
  assert.deepEqual(ids(merged.document), ['A', 'B', 'C']);
  const deletion = mergeInk(base, doc([]), doc([a, c]));
  assert.equal(deletion.conflict, false);
  assert.deepEqual(ids(deletion.document), ['C']);
  const remoteDeletion = mergeInk(base, doc([a, b]), doc([]));
  assert.deepEqual(ids(remoteDeletion.document), ['B']);
});

test('same-stroke simultaneous edits preserve the full incoming document as a conflict copy', async () => {
  const base = doc([mark('A')]);
  const { store, io, notices } = fixture(base);
  const session = await store.get(note);
  const remote = doc([mark('A', { color: '#16a34a' }), mark('remote')]);
  io.files.set(file, JSON.stringify(remote));
  session.replace([mark('A', { color: '#dc2626' }), mark('local')]);
  await session.flush();
  const result = validateDocument(JSON.parse(io.files.get(file)!), note);
  assert.deepEqual(ids(result), ['A', 'local', 'remote']);
  assert.equal(result.strokes.find(s => s.id === 'A')?.color, '#dc2626');
  const backups = [...io.files].filter(([path]) => path.includes('.conflict-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(backups[0][1]), remote);
  assert.equal(notices.filter(message => message.includes('both versions')).length, 1);
});

test('corrupt or future-format data is preserved byte-for-byte and never overwritten', async () => {
  for (const raw of ['{broken JSON', JSON.stringify({ version: 7, strokes: [] })]) {
    const io = new MemoryIO(); io.files.set(file, raw);
    const store = new InkStore(io, () => 'Inkspace Data', () => {});
    await assert.rejects(store.get(note), /preserved/);
    assert.equal(io.files.get(file), raw);
    assert.equal(io.writes.length, 0);
    // A failed load must not poison the pending-session cache.
    io.files.set(file, JSON.stringify(doc([mark('recovered')])));
    const session = await store.get(note);
    assert.deepEqual(ids(session.document), ['recovered']);
    await session.flush();
  }
});

test('concurrent callers load and share one model without a second vault read', async () => {
  const { store, io } = fixture(doc([mark('A')]));
  const [left, right, other] = await Promise.all([store.get(note), store.get(note), store.get(note)]);
  assert.equal(left, right); assert.equal(right, other);
  assert.equal(io.reads, 1);
  left.add([mark('B')]);
  assert.deepEqual(ids(right.document), ['A', 'B']);
  await store.flushAll();
});

test('a remote merge survives local drawing received while its disk write is pending', async () => {
  const { store, io } = fixture(doc([mark('A')]));
  const session = await store.get(note);
  io.files.set(file, JSON.stringify(doc([mark('A'), mark('remote')])));
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { started = resolve; });
  let first = true;
  io.beforeWrite = async path => { if (path === file && first) { first = false; started(); await gate; } };
  session.add([mark('local-before')]);
  const saving = session.flush();
  await writing;
  session.add([mark('local-during')]);
  release(); await saving;
  const final = validateDocument(JSON.parse(io.files.get(file)!), note);
  assert.deepEqual(ids(final), ['A', 'local-before', 'local-during', 'remote']);
  assert.deepEqual(ids(session.document), ids(final));
});

test('remote text anchors are reconciled to the local source before persisting merged ink', async () => {
  const localText = 'target';
  const base = doc([mark('A', { anchor: createAnchor(localText, 0, 6, 0, 0) })], localText);
  const { store, io } = fixture(base);
  const session = await store.get(note, localText);
  const remoteText = 'A much longer prefix target';
  const remote = doc([...base.strokes, mark('remote', { anchor: createAnchor(remoteText, 21, 27, 0, 0) })], remoteText);
  io.files.set(file, JSON.stringify(remote));
  session.add([mark('local')]); await session.flush();
  const final = validateDocument(JSON.parse(io.files.get(file)!), note);
  assert.deepEqual(ids(final), ['A', 'local', 'remote']);
  assert.equal(final.strokes.find(s => s.id === 'remote')?.anchor?.from, 0);
  assert.equal(final.sourceText, localText);
});

test('remote deletion keeps pending work in a recovery file and does not recreate the removed file', async () => {
  const { store, io } = fixture(doc([mark('A')]));
  const session = await store.get(note);
  session.add([mark('pending')]); io.files.delete(file);
  await assert.rejects(session.flush(), /removed on another device/);
  assert.equal(io.files.has(file), false);
  const recovery = [...io.files].find(([path]) => path.includes('.recovered-'));
  assert.ok(recovery);
  assert.deepEqual(ids(validateDocument(JSON.parse(recovery[1]), note)), ['A', 'pending']);
});

test('unreadable incoming data stops saving without replacing the incoming bytes', async () => {
  const { store, io } = fixture(doc([mark('A')]));
  const session = await store.get(note);
  session.add([mark('pending')]); io.files.set(file, 'not JSON');
  await assert.rejects(session.flush(), /unreadable/);
  assert.equal(io.files.get(file), 'not JSON');
  assert.equal(io.writes.length, 0);
});

test('renaming a loaded note preserves its session, undo history and ink without attaching it to a reused old path', async () => {
  const { store, io } = fixture(doc([mark('A')]));
  const oldSession = await store.get(note);
  oldSession.add([mark('B')]);
  const renamed = 'Renamed.md', renamedFile = sidecarPath('Inkspace Data',renamed);
  await store.rename(note,renamed);
  const newSession = await store.get(renamed);
  assert.equal(oldSession,newSession);
  assert.equal(oldSession.path,renamed);
  assert.equal(oldSession.document.notePath,renamed);
  assert.equal(io.files.has(file),false);
  assert.deepEqual(ids(validateDocument(JSON.parse(io.files.get(renamedFile)!),renamed)),['A','B']);
  const backup = [...io.files].find(([path]) => path.startsWith(`${file}.renamed-backup-`));
  assert.ok(backup);
  assert.deepEqual(ids(validateDocument(JSON.parse(backup[1]),note)),['A','B']);
  oldSession.undo(); await oldSession.flush();
  assert.deepEqual(ids(oldSession.document),['A']);
  const reused = await store.get(note,'A newly created note');
  assert.notEqual(reused,newSession);
  assert.deepEqual(ids(reused.document),[]);
  reused.add([mark('new-source')]); await reused.flush();
  assert.deepEqual(ids(newSession.document),['A']);
});

test('cold rename migrates unopened note sidecars while preserving source text and anchors', async () => {
  const text='Lecture target';
  const { store,io }=fixture(doc([mark('A',{anchor:createAnchor(text,8,14,20,30)})],text));
  await store.rename(note,'Course/Renamed.md');
  const moved=await store.get('Course/Renamed.md',text);
  assert.equal(moved.document.sourceText,text);
  assert.equal(moved.document.strokes[0].anchor?.from,8);
  assert.deepEqual(ids(moved.document),['A']);
  assert.equal(io.files.has(file),false);
});

test('a target session opened before the rename redirects its references and subscriptions to the original ink', async () => {
  const {store}=fixture(doc([mark('A')]));
  const target=await store.get('Renamed.md');
  let updates=0;
  const unsubscribe=target.subscribe(()=>updates++);
  const source=await store.get(note);
  await store.rename(note,'Renamed.md');
  assert.deepEqual(ids(target.document),['A']);
  target.add([mark('B')]); await target.flush();
  assert.deepEqual(ids(source.document),['A','B']);
  assert.ok(updates>=2);
  unsubscribe();
  const count=updates;
  source.add([mark('C')]); await source.flush();
  assert.equal(updates,count);
});

test('get during a pending rename waits for migration instead of caching an empty target', async () => {
  const {store,io}=fixture(doc([mark('A')]));
  const targetFile=sidecarPath('Inkspace Data','Renamed.md');
  let release!:()=>void, started!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve), writing=new Promise<void>(resolve=>started=resolve);
  io.beforeWrite=async path=>{if(path===targetFile){started();await gate;}};
  const renaming=store.rename(note,'Renamed.md');
  await writing;
  const pending=store.get('Renamed.md');
  let resolved=false; void pending.then(()=>resolved=true);
  await Promise.resolve(); assert.equal(resolved,false);
  release(); await renaming;
  assert.deepEqual(ids((await pending).document),['A']);
});

test('drawing and erasing through both open sessions survive a pending rename and queued autosaves', async () => {
  const {store,io}=fixture(doc([mark('A'),mark('erase-me')]));
  const source=await store.get(note), target=await store.get('Renamed.md');
  target.add([mark('target-before')]); await target.flush();
  const targetFile=sidecarPath('Inkspace Data','Renamed.md');
  let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve), writing=new Promise<void>(resolve=>started=resolve);
  let first=true;
  io.beforeWrite=async path=>{if(path===targetFile&&first){first=false;started();await gate;}};
  const renaming=store.rename(note,'Renamed.md'); await writing;
  source.replace([mark('A'),mark('source-during')]);
  target.add([mark('target-during')]);
  const sourceSaving=source.flush(), targetSaving=target.flush();
  release(); await Promise.all([renaming,sourceSaving,targetSaving]);
  await store.flushAll();
  const expected=['A','source-during','target-before','target-during'];
  assert.deepEqual(ids(source.document),expected);
  assert.deepEqual(ids(target.document),expected);
  assert.deepEqual(ids(validateDocument(JSON.parse(io.files.get(targetFile)!), 'Renamed.md')),expected);
  assert.equal(io.files.has(file),false,'Queued old-source writes must never recreate an active old sidecar.');
});

test('folder rename migrates both loaded and unopened descendants without touching adjacent folders or recovery files', async () => {
  const io=new MemoryIO();
  for(const [path,id] of [['Course/A.md','A'],['Course/Nested/B.md','B'],['Coursework/C.md','C']]) io.files.set(sidecarPath('Inkspace Data',path),JSON.stringify({...createDocument(path),strokes:[mark(id)]}));
  io.files.set(`${sidecarPath('Inkspace Data','Course/A.md')}.recovered-123.json`,'recovery bytes');
  const store=new InkStore(io,()=> 'Inkspace Data',()=>{});
  const loaded=await store.get('Course/A.md');
  await store.renameFolder('Course','Semester');
  assert.equal(loaded.path,'Semester/A.md');
  assert.deepEqual(ids((await store.get('Semester/Nested/B.md')).document),['B']);
  assert.deepEqual(ids((await store.get('Coursework/C.md')).document),['C']);
  assert.equal(io.files.get(`${sidecarPath('Inkspace Data','Course/A.md')}.recovered-123.json`),'recovery bytes');
  assert.equal(io.files.has(sidecarPath('Inkspace Data','Course/Nested/B.md')),false);
});

test('rename without removal support retires the old sidecar as an empty tombstone after preserving a full recovery copy', async () => {
  const io=new MemoryIO();io.files.set(file,JSON.stringify(doc([mark('A')])));
  const store=new InkStore({read:path=>io.read(path),write:(path,data)=>io.write(path,data)},()=> 'Inkspace Data',()=>{});
  await store.rename(note,'Renamed.md');
  const tombstone=JSON.parse(io.files.get(file)!);
  assert.equal(tombstone.renamedTo,'Renamed.md');
  assert.deepEqual(tombstone.strokes,[]);
  assert.deepEqual(ids(validateDocument(JSON.parse(io.files.get(tombstone.recovery)!),note)),['A']);
  assert.deepEqual(ids((await store.get(note)).document),[]);
  assert.deepEqual(ids((await store.get('Renamed.md')).document),['A']);
});

test('failed target writes preserve the original active ink and release the lifecycle queue for retry', async () => {
  const {store,io}=fixture(doc([mark('A')]));
  const source=await store.get(note), targetFile=sidecarPath('Inkspace Data','Renamed.md');
  io.beforeWrite=async path=>{if(path===targetFile)throw new Error('Disk full');};
  await assert.rejects(store.rename(note,'Renamed.md'),/Disk full/);
  assert.equal(source.path,note);
  assert.deepEqual(ids(validateDocument(JSON.parse(io.files.get(file)!),note)),['A']);
  source.add([mark('B')]);await source.flush();
  io.beforeWrite=undefined;
  await store.rename(note,'Renamed.md');
  assert.deepEqual(ids((await store.get('Renamed.md')).document),['A','B']);
});

test('a cold remote update received before renaming is merged with a loaded session rather than overwritten', async () => {
  const {store,io}=fixture(doc([mark('A')]));
  await store.get(note);
  io.files.set(file,JSON.stringify(doc([mark('A'),mark('remote')])));
  await store.rename(note,'Renamed.md');
  assert.deepEqual(ids((await store.get('Renamed.md')).document),['A','remote']);
});

test('refresh preserves drawing and erasing received while its disk read is pending', async () => {
  const {store,io}=fixture(doc([mark('A'),mark('erase-me')]));
  const session=await store.get(note);
  io.files.set(file,JSON.stringify(doc([mark('A'),mark('erase-me'),mark('remote')])));
  let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve), reading=new Promise<void>(resolve=>started=resolve);
  let first=true;
  io.beforeRead=async path=>{if(path===file&&first){first=false;started();await gate;}};
  const refresh=store.refresh(note);await reading;
  session.replace([mark('A'),mark('local-during-read')]);
  release();await refresh;await session.flush();
  assert.deepEqual(ids(session.document),['A','local-during-read','remote']);
  assert.deepEqual(ids(validateDocument(JSON.parse(io.files.get(file)!),note)),['A','local-during-read','remote']);
});

test('refresh preserves full incoming conflict data and includes writing received during its backup write', async () => {
  const {store,io,notices}=fixture(doc([mark('A')]));
  const session=await store.get(note);
  const remote=doc([mark('A',{color:'#16a34a'}),mark('remote')]);
  io.files.set(file,JSON.stringify(remote));
  let releaseRead!:()=>void,startedRead!:()=>void,releaseBackup!:()=>void,startedBackup!:()=>void;
  const readGate=new Promise<void>(resolve=>releaseRead=resolve),reading=new Promise<void>(resolve=>startedRead=resolve);
  const backupGate=new Promise<void>(resolve=>releaseBackup=resolve),backingUp=new Promise<void>(resolve=>startedBackup=resolve);
  let first=true;
  io.beforeRead=async path=>{if(path===file&&first){first=false;startedRead();await readGate;}};
  io.beforeWrite=async path=>{if(path.includes('.conflict-')){startedBackup();await backupGate;}};
  const refresh=store.refresh(note);await reading;
  session.replace([mark('A',{color:'#dc2626'}),mark('local-during-read')]);
  releaseRead();await backingUp;
  session.add([mark('local-during-backup')]);
  releaseBackup();await refresh;await session.flush();
  assert.deepEqual(ids(session.document),['A','local-during-backup','local-during-read','remote']);
  assert.equal(session.document.strokes.find(stroke=>stroke.id==='A')?.color,'#dc2626');
  const backups=[...io.files].filter(([path])=>path.includes('.conflict-'));
  assert.equal(backups.length,1);
  assert.deepEqual(JSON.parse(backups[0][1]),remote);
  assert.equal(notices.filter(text=>text.includes('both versions')).length,1);
});

test('a completed save during refresh cannot be rolled back by its older read', async () => {
  const {store,io}=fixture(doc([mark('A')]));
  const session=await store.get(note);
  io.files.set(file,JSON.stringify(doc([mark('A'),mark('remote')])));
  let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve),reading=new Promise<void>(resolve=>started=resolve);
  let first=true;
  io.beforeRead=async path=>{if(path===file&&first){first=false;started();await gate;}};
  const refresh=store.refresh(note);await reading;
  session.add([mark('local')]);await session.flush();
  const saved=io.files.get(file);
  release();await refresh;await session.flush();
  assert.equal(io.files.get(file),saved);
  assert.deepEqual(ids(session.document),['A','local','remote']);
});
