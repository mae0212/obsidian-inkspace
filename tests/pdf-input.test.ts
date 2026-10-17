import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceLeaf } from 'obsidian';
import { InkspacePdfView } from '../src/pdf';
import { createDocument, INK_LIMITS, InkModel } from '../src/core';
import { DEFAULT_SETTINGS, type InkHost, type InkSession, type Stroke } from '../src/types';

const mark=(id:string,patch:Partial<Stroke>={}):Stroke=>({id,tool:'pen',page:1,points:[{x:30,y:40,pressure:.5}],color:'#2563eb',width:3,opacity:1,updatedAt:1,...patch});
interface PdfInputHarness {
  session: InkSession;
  pointerId: number | null;
  activeStroke: Stroke | null;
  erasedIds: Set<string> | null;
  ink: HTMLCanvasElement;
  pointerMove(event: PointerEvent): void;
  pointerUp(event: PointerEvent): void;
  schedulePaint(): void;
}
function fixture(strokes:Stroke[]) {
  const saved:Stroke[][]=[],notices:{message:string;error?:boolean}[]=[],released:number[]=[];
  const session=new InkModel({...createDocument('Lecture.pdf'),strokes},async document=>{saved.push(document.strokes);});
  const host={getSettings:()=>DEFAULT_SETTINGS,status:(message:string,error?:boolean)=>notices.push({message,error})} as unknown as InkHost;
  // The real event handler runs against an InkModel. Renderer/DOM work is
  // excluded so the test controls exactly when another editor adds new ink.
  const view=new InkspacePdfView({} as WorkspaceLeaf,host) as unknown as PdfInputHarness;
  view.session=session;
  view.ink={hasPointerCapture:()=>true,releasePointerCapture:(pointer:number)=>released.push(pointer)} as unknown as HTMLCanvasElement;
  view.pointerMove=()=>{};
  let paints=0;view.schedulePaint=()=>{paints++;};
  return {view,session,saved,notices,released,get paints(){return paints;}};
}

test('PDF eraser commit removes targeted IDs from the latest shared document and retains concurrent additions',async()=>{
  const {view,session,saved,notices,released}=fixture([mark('erased'),mark('kept')]);
  view.pointerId=7;
  view.erasedIds=new Set(['erased']);
  // A synced stroke or another PDF pane can update the shared session while
  // this pane still has its eraser on the page.
  session.add([mark('arrived-during-erase')]);
  view.pointerUp({pointerId:7} as PointerEvent);
  await session.flush();
  assert.deepEqual(session.document.strokes.map(stroke=>stroke.id),['kept','arrived-during-erase']);
  assert.deepEqual(saved.at(-1)?.map(stroke=>stroke.id),['kept','arrived-during-erase']);
  assert.equal(view.pointerId,null);
  assert.equal(view.erasedIds,null);
  assert.deepEqual(released,[7]);
  assert.deepEqual(notices,[]);
});

test('PDF rejected stroke preserves saved ink, reports the error and releases the gesture so writing can continue',async()=>{
  const {view,session,saved,notices,released}=fixture([mark('existing')]);
  view.pointerId=8;
  view.activeStroke=mark('outside-supported-canvas',{points:[{x:INK_LIMITS.coordinate+1,y:20,pressure:.5}]});
  assert.doesNotThrow(()=>view.pointerUp({pointerId:8} as PointerEvent));
  assert.deepEqual(session.document.strokes.map(stroke=>stroke.id),['existing']);
  assert.equal(session.canUndo,false,'Rejecting the stroke must not change valid undo history.');
  assert.equal(view.pointerId,null);
  assert.equal(view.activeStroke,null);
  assert.deepEqual(released,[8]);
  assert.equal(notices.length,1);
  assert.equal(notices[0].error,true);
  assert.match(notices[0].message,/supported range/);
  await session.flush();
  assert.equal(saved.length,0,'An invalid stroke must never create a new disk snapshot.');
  view.pointerId=9;view.activeStroke=mark('next-valid-stroke');
  view.pointerUp({pointerId:9} as PointerEvent);await session.flush();
  assert.deepEqual(session.document.strokes.map(stroke=>stroke.id),['existing','next-valid-stroke']);
  assert.deepEqual(released,[8,9]);
});
