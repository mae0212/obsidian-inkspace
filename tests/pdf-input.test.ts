import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceLeaf } from 'obsidian';
import { InkspacePdfView } from '../src/pdf';
import { createDocument, INK_LIMITS, InkModel } from '../src/core';
import { createStrokeStabilizer } from '../src/stabilizer';
import { DEFAULT_SETTINGS, type InkHost, type InkSession, type Point, type Stroke } from '../src/types';

const mark=(id:string,patch:Partial<Stroke>={}):Stroke=>({id,tool:'pen',page:1,points:[{x:30,y:40,pressure:.5}],color:'#2563eb',width:3,opacity:1,updatedAt:1,...patch});
interface PdfInputHarness {
  session: InkSession;
  pointerId: number | null;
  activeStroke: Stroke | null;
  stabilizer: ReturnType<typeof createStrokeStabilizer> | null;
  lastSample: Point | null;
  erasedIds: Set<string> | null;
  lasso: Point[] | null;
  pdf: object | null;
  pageWidth: number;
  pageHeight: number;
  zoom: number;
  ink: HTMLCanvasElement;
  pointerDown(event: PointerEvent): void;
  pointerMove(event: PointerEvent): void;
  pointerUp(event: PointerEvent): void;
  pointerCancel(event: PointerEvent): void;
  schedulePaint(): void;
}
function fixture(strokes:Stroke[], realInput=false) {
  const saved:Stroke[][]=[],notices:{message:string;error?:boolean}[]=[],released:number[]=[];
  const session=new InkModel({...createDocument('Lecture.pdf'),strokes},async document=>{saved.push(document.strokes);});
  const settings={...DEFAULT_SETTINGS};
  const host={getSettings:()=>settings,status:(message:string,error?:boolean)=>notices.push({message,error})} as unknown as InkHost;
  // The real event handler runs against an InkModel. Renderer/DOM work is
  // excluded so the test controls exactly when another editor adds new ink.
  const view=new InkspacePdfView({} as WorkspaceLeaf,host) as unknown as PdfInputHarness;
  view.session=session;
  view.pdf={};view.pageWidth=300;view.pageHeight=400;view.zoom=2;
  view.ink={
    getBoundingClientRect:()=>({left:100,top:50,width:600,height:800}),
    setPointerCapture:()=>{},focus:()=>{},hasPointerCapture:()=>true,
    releasePointerCapture:(pointer:number)=>released.push(pointer),
  } as unknown as HTMLCanvasElement;
  if (!realInput) view.pointerMove=()=>{};
  let paints=0;view.schedulePaint=()=>{paints++;};
  return {view,session,saved,notices,released,settings,get paints(){return paints;}};
}

function sample(x:number,y:number,t:number,patch:Partial<PointerEvent>={}):PointerEvent {
  return {pointerId:17,pointerType:'pen',button:0,buttons:1,clientX:100+x*2,clientY:50+y*2,pressure:.7,timeStamp:t,preventDefault:()=>{},...patch} as PointerEvent;
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

test('PDF handwriting filters every coalesced sample in page coordinates and retains the terminal movement',async()=>{
  const previous=mark('legacy');const original=structuredClone(previous);
  const {view,session,notices}=fixture([previous],true);
  view.pointerDown(sample(10,20,0));
  const a=sample(14,20.7,8),b=sample(18,19.3,16);
  view.pointerMove(sample(22,20.7,24,{getCoalescedEvents:()=>[a,b]}));
  const lift=sample(26,19.3,32,{pressure:0,getCoalescedEvents:()=>[]});
  view.pointerUp(lift);await session.flush();
  const stroke=session.document.strokes[1];
  const filter=createStrokeStabilizer('natural');
  const expected=[{x:10,y:20,pressure:.7,t:0},{x:14,y:20.7,pressure:.7,t:8},{x:18,y:19.3,pressure:.7,t:16},{x:22,y:20.7,pressure:.7,t:24},{x:26,y:19.3,pressure:.7,t:32}].map(point=>filter.next(point));
  assert.equal(stroke.points.length,5,'Historical samples and the dispatch endpoint must all reach the stabilizer.');
  for(let index=0;index<expected.length;index++) {
    assert.ok(Math.abs(stroke.points[index].x-expected[index].x)<1e-8);
    assert.ok(Math.abs(stroke.points[index].y-expected[index].y)<1e-8);
    assert.equal(stroke.points[index].t,expected[index].t);
  }
  assert.equal(stroke.points.at(-1)?.pressure,.7,'Lifting the Pencil must not replace contact pressure with a fabricated half-pressure tail.');
  assert.deepEqual(session.document.strokes[0],original,'Previously saved marks must retain their exact geometry.');
  assert.deepEqual(notices,[]);
  assert.equal(view.stabilizer,null);assert.equal(view.lastSample,null);
});

test('PDF stationary lift commits the live points unchanged and stabilization stays fixed for each gesture',async()=>{
  const {view,session,settings}=fixture([],true);
  view.pointerDown(sample(10,20,0));
  view.pointerMove(sample(15,22,8));
  settings.stabilization='off';
  view.pointerMove(sample(20,18,16));
  const live=structuredClone(view.activeStroke!.points);
  assert.notEqual(live.at(-1)?.y,18,'Changing the global mode must not switch the filter halfway through a stroke.');
  view.pointerUp(sample(20,18,24,{pressure:0}));
  assert.deepEqual(session.document.strokes[0].points,live,'Pen lift must not reprocess the curve or snap its endpoint.');
  view.pointerDown(sample(40,60,32));
  view.pointerMove(sample(48,64,40));
  view.pointerUp(sample(48,64,48));await session.flush();
  assert.deepEqual(session.document.strokes[1].points.map(({x,y})=>({x,y})),[{x:40,y:60},{x:48,y:64}]);
});

test('PDF highlighters share stabilization and cancellation discards the filter before the next gesture',async()=>{
  const {view,session,settings}=fixture([],true);settings.tool='highlighter';
  view.pointerDown(sample(10,20,0));view.pointerMove(sample(18,22,8));
  assert.ok(view.stabilizer);assert.notEqual(view.activeStroke!.points.at(-1)?.y,22);
  view.pointerCancel(sample(18,22,16));
  assert.equal(view.stabilizer,null);assert.equal(view.lastSample,null);assert.equal(session.document.strokes.length,0);
  view.pointerDown(sample(200,300,24));
  assert.deepEqual(view.activeStroke!.points[0],{x:200,y:300,pressure:.7,t:24},'The first point must not inherit the cancelled filter state.');
  view.pointerUp(sample(206,302,32));await session.flush();
  assert.equal(session.document.strokes[0].tool,'highlighter');
  assert.equal(session.document.strokes[0].width,DEFAULT_SETTINGS.highlighterWidth);
});

test('PDF shapes and lasso keep their raw positions while invalid geometry never starts a gesture',async()=>{
  const {view,session,settings}=fixture([],true);settings.tool='line';
  view.pointerDown(sample(10,20,0));
  assert.equal(view.stabilizer,null);
  view.pointerMove(sample(20,35,8,{getCoalescedEvents:()=>[sample(14,22,4)]}));
  view.pointerUp(sample(30,15,16));
  assert.deepEqual(session.document.strokes[0].points.map(({x,y})=>({x,y})),[{x:10,y:20},{x:30,y:15}]);
  settings.tool='lasso';view.pointerDown(sample(40,40,24));view.pointerMove(sample(60,42,32));
  assert.equal(view.stabilizer,null);
  assert.deepEqual(view.lasso?.map(({x,y})=>({x,y})),[{x:40,y:40},{x:60,y:42}]);
  view.pointerCancel(sample(60,42,40));
  view.ink.getBoundingClientRect=()=>({left:100,top:50,width:0,height:0}) as DOMRect;
  settings.tool='pen';view.pointerDown(sample(10,20,48));
  assert.equal(view.pointerId,null);assert.equal(view.stabilizer,null);
  await session.flush();
});
