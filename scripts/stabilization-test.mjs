import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as esbuild from 'esbuild';

await esbuild.build({entryPoints:['preview/main.ts'],bundle:true,format:'iife',target:'es2020',outfile:'preview/bundle.js'});
const engine = process.env.INKSPACE_BROWSER === 'webkit' ? 'webkit' : 'edge';
const browser = await (engine === 'webkit' ? webkit.launch({headless:true}) : chromium.launch({channel:'msedge',headless:true}));
const page = await browser.newPage({viewport:{width:1440,height:1050}});
const errors=[]; page.on('pageerror',error=>errors.push(error.message));
const settled=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
await fs.mkdir('work/screenshots',{recursive:true});

try {
  await page.goto('http://127.0.0.1:4173');
  await page.evaluate(()=>localStorage.clear()); await page.reload();
  await page.waitForFunction(()=>window.inkspaceTest?.view);
  await page.evaluate(async()=>{await window.inkspaceTest.getSession();window.inkspaceTest.host.updateSettings({mouseDrawing:false,tool:'pen',usePressure:true});});
  await settled();
  const origin=await page.evaluate(()=>{const t=window.inkspaceTest,p=t.view.coordsAtPos(t.view.state.doc.toString().indexOf('Circle an idea'));return{x:p.left+20,y:p.top+100};});
  let pointerId=300;
  const draw=async(points,{mode='natural',tool='pen',batched=false,changeAfterDown}={})=>{
    const id=++pointerId;
    const result=await page.evaluate(async({points,mode,tool,batched,changeAfterDown,id})=>{
      const t=window.inkspaceTest; t.host.updateSettings({stabilization:mode,tool});
      const target=t.view.contentDOM;
      const make=(point,type)=>{
        const e=new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:id,pointerType:'pen',isPrimary:true,button:0,buttons:type==='pointerup'?0:1,clientX:point.x,clientY:point.y,pressure:type==='pointerup'?0:point.pressure});
        Object.defineProperty(e,'timeStamp',{value:point.t});return e;
      };
      target.dispatchEvent(make(points[0],'pointerdown'));
      if(changeAfterDown)t.host.updateSettings({stabilization:changeAfterDown});
      if(batched){
        for(let i=1;i<points.length;i+=7){
          const group=points.slice(i,i+7),event=make(group.at(-1),'pointermove');
          // The dispatch event itself is later than its historical coalesced samples.
          Object.defineProperty(event,'getCoalescedEvents',{value:()=>group.slice(0,-1).map(point=>make(point,'pointermove'))});
          target.dispatchEvent(event);
        }
      }else for(const point of points.slice(1))target.dispatchEvent(make(point,'pointermove'));
      const s=await t.getSession();
      // Finish at the same coordinate with a zero-pressure pen lift.
      target.dispatchEvent(make({...points.at(-1),t:points.at(-1).t+8},'pointerup'));
      return structuredClone(s.document.strokes.at(-1));
    },{points,mode,tool,batched,changeAfterDown,id});
    await settled();return result;
  };
  const noisy=Array.from({length:181},(_,i)=>({x:origin.x+i*.8,y:origin.y+(i%2?1.1:-1.1),pressure:.2+(i%31)/50,t:10000+i*1000/120}));
  const rms=(stroke,center)=>Math.sqrt(stroke.points.slice(30,-4).reduce((sum,p)=>sum+(p.y-center)**2,0)/(stroke.points.length-34));
  const reports={};
  for(const tool of ['pen','highlighter']){
    const off=await draw(noisy,{mode:'off',tool});
    const natural=await draw(noisy,{mode:'natural',tool});
    const strong=await draw(noisy,{mode:'strong',tool});
    const center=(Math.min(...off.points.map(p=>p.y))+Math.max(...off.points.map(p=>p.y)))/2;
    const before=rms(off,center),after=rms(natural,center),strongRms=rms(strong,center);
    assert.ok(after<before*.65,`${tool}: Natural suppresses alternating small shakes, ${after}/${before}`);
    assert.ok(strongRms<=after+.05,`${tool}: Strong provides at least as much small-shake reduction`);
    assert.deepEqual(natural.points[0],off.points[0],'The first contact is exact');
    assert.ok(Math.abs(natural.points.at(-1).x-off.points.at(-1).x)<3,'The drawn endpoint stays near the contact, rather than long trailing ink');
    assert.ok(Math.abs(natural.points.at(-1).pressure-noisy.at(-1).pressure)<1e-6,'Zero-pressure lift retains the previous contact pressure');
    assert.equal(natural.points.at(-1).t,noisy.at(-1).t,'A stationary pen lift does not append a trailing sample');
    reports[tool]={rawRms:before,naturalRms:after,strongRms,points:natural.points.length};
  }

  const individual=await draw(noisy,{mode:'natural'});
  const batched=await draw(noisy,{mode:'natural',batched:true});
  assert.deepEqual(batched.points,individual.points,'Identical samples produce identical ink regardless of coalesced event grouping');
  const frozen=await draw(noisy,{mode:'natural',changeAfterDown:'off'});
  assert.deepEqual(frozen.points,individual.points,'Changing stabilization during a stroke affects the next stroke only');

  const movingLift=await page.evaluate(async({origin,id})=>{
    const t=window.inkspaceTest;t.host.updateSettings({tool:'pen',stabilization:'natural'});
    const make=(type,x,y,time,pressure)=>{const e=new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:id,pointerType:'pen',isPrimary:true,button:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:y,pressure});Object.defineProperty(e,'timeStamp',{value:time});return e;};
    const emit=(type,x,y,time,pressure)=>{const e=make(type,x,y,time,pressure);if(type==='pointerup')Object.defineProperty(e,'getCoalescedEvents',{value:()=>[make('pointermove',origin.x+15,origin.y+31,18012,0)]});t.view.contentDOM.dispatchEvent(e);};
    emit('pointerdown',origin.x,origin.y+30,18000,.3);
    emit('pointermove',origin.x+10,origin.y+30,18008,.55);
    emit('pointerup',origin.x+22,origin.y+32,18016,0);
    return structuredClone((await t.getSession()).document.strokes.at(-1));
  },{origin,id:++pointerId});
  assert.equal(movingLift.points.at(-1).t,18016,'A moving pen lift retains its final event sample');
  assert.ok(Math.abs(movingLift.points.at(-1).pressure-.55)<1e-6,'A moving lift retains the last contact pressure');
  assert.ok(movingLift.points.at(-1).x-movingLift.points[1].x>8,'The final movement is drawn, not lost on lift');
  assert.ok(movingLift.points.slice(1).every(p=>Math.abs(p.pressure-.55)<1e-6),'Zero-pressure coalesced release history also retains the last actual contact pressure');

  const loop=Array.from({length:121},(_,i)=>{const angle=2*Math.PI*i/120;return{x:origin.x+230+9*Math.cos(angle)+(i%2?.5:-.5),y:origin.y+9*Math.sin(angle),pressure:.5,t:20000+i*1000/120};});
  const loopOff=await draw(loop,{mode:'off'}),loopNatural=await draw(loop,{mode:'natural'});
  const area=stroke=>Math.abs(stroke.points.reduce((sum,p,i,ps)=>{const n=ps[(i+1)%ps.length];return sum+p.x*n.y-p.y*n.x;},0)/2);
  assert.ok(area(loopNatural)>area(loopOff)*.72,'A small handwriting loop retains its enclosed area');
  const horizontal=stroke=>Math.max(...stroke.points.map(p=>p.x))-Math.min(...stroke.points.map(p=>p.x));
  assert.ok(horizontal(loopNatural)>horizontal(loopOff)*.78,'A small loop is not flattened into a line');
  const dot=await draw([{x:origin.x+310,y:origin.y,pressure:.4,t:30000}],{mode:'strong'});
  assert.equal(dot.points.length,1,'A tap still creates one dot');

  // A new gesture starts at its actual contact even after a distant stroke.
  const tiny=await draw([{x:origin.x+340,y:origin.y+40,pressure:.6,t:31000},{x:origin.x+342,y:origin.y+41,pressure:.7,t:31008}],{mode:'natural'});
  const offTiny=await draw([{x:origin.x+340,y:origin.y+40,pressure:.6,t:31000},{x:origin.x+342,y:origin.y+41,pressure:.7,t:31008}],{mode:'off'});
  assert.deepEqual(tiny.points[0],offTiny.points[0],'Separate pen lifts do not bridge or carry filter state into the next letter');
  assert.ok(tiny.points.length>=2,'A short stroke is not discarded');

  // Inspect a rendered in-progress pen stroke and finish with the very same sample.
  // No post-lift beautification should change the existing curve.
  const lift=await page.evaluate(async({origin,id})=>{
    const t=window.inkspaceTest;t.host.updateSettings({tool:'pen',stabilization:'natural',usePressure:false});
    const target=t.view.contentDOM;
    const emit=(type,x,y,time)=>{const e=new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:id,pointerType:'pen',isPrimary:true,button:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:y,pressure:type==='pointerup'?0:.5});Object.defineProperty(e,'timeStamp',{value:time});target.dispatchEvent(e);};
    emit('pointerdown',origin.x,origin.y+70,40000);
    for(let i=1;i<80;i++)emit('pointermove',origin.x+i*1.2,origin.y+70+Math.sin(i/7)*6,40000+i*8);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const live=document.querySelector('.inkspace-live-ink'),saved=document.querySelector('.inkspace-saved-ink');
    const composite=document.createElement('canvas');composite.width=live.width;composite.height=live.height;
    const c=composite.getContext('2d');c.drawImage(saved,0,0);c.drawImage(live,0,0);
    const before=c.getImageData(0,0,composite.width,composite.height).data;
    const beforeCount=(await t.getSession()).document.strokes.length;
    emit('pointerup',origin.x+79*1.2,origin.y+70+Math.sin(79/7)*6,40000+79*8);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const after=saved.getContext('2d').getImageData(0,0,saved.width,saved.height).data;
    let changedPixels=0;
    for(let i=0;i<before.length;i+=4)if(Math.max(...[0,1,2,3].map(channel=>Math.abs(before[i+channel]-after[i+channel])))>4)changedPixels++;
    return{changedPixels,beforeCount,afterCount:(await t.getSession()).document.strokes.length,points:(await t.getSession()).document.strokes.at(-1).points};
  },{origin,id:++pointerId});
  assert.equal(lift.afterCount,lift.beforeCount+1,'Lift commits exactly one stroke');
  assert.ok(lift.points.length>50,'Live handwriting retains its path through lift');
  assert.ok(lift.changedPixels<8,`Stationary lift preserves the already rendered curve (${lift.changedPixels} changed pixels)`);

  const snapshot=await page.evaluate(async()=>{const s=await window.inkspaceTest.getSession();await s.flush();return JSON.stringify(s.document.strokes);});
  await page.evaluate(()=>window.inkspaceTest.host.updateSettings({stabilization:'strong'}));
  assert.equal(await page.evaluate(async()=>JSON.stringify((await window.inkspaceTest.getSession()).document.strokes)),snapshot,'Changing modes never restyles or rewrites saved handwriting');
  await page.getByRole('button',{name:'Undo ink',exact:true}).click();
  await page.getByRole('button',{name:'Redo ink',exact:true}).click();
  assert.equal(await page.evaluate(async()=>JSON.stringify((await window.inkspaceTest.getSession()).document.strokes)),snapshot,'Ink undo/redo preserves filtered vectors');
  await page.evaluate(async()=>await(await window.inkspaceTest.getSession()).flush());
  await page.reload();await page.waitForFunction(()=>window.inkspaceTest?.view);
  assert.equal(await page.evaluate(async()=>JSON.stringify((await window.inkspaceTest.getSession()).document.strokes)),snapshot,'Filtered vectors survive save and reopening unchanged');
  await page.locator('.inkspace-more > summary').click();
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export ink as SVG',exact:true}).click();
  const download=await downloadPromise;const svg=await fs.readFile(await download.path(),'utf8');
  assert.equal((svg.match(/<path /g)||[]).length,JSON.parse(snapshot).length,'SVG exports every saved stroke');
  assert.ok(!/NaN|Infinity/.test(svg),'Export geometry stays finite');
  assert.equal(await page.evaluate(async()=>JSON.stringify((await window.inkspaceTest.getSession()).document.strokes)),snapshot,'Export does not apply a second stabilization pass');
  await page.screenshot({path:`work/screenshots/stabilization-${engine}.png`});
  assert.deepEqual(errors,[],'No runtime errors during real editor stabilization');
  await fs.writeFile(`work/stabilization-${engine}-result.json`,JSON.stringify({engine,reports,loopArea:{raw:area(loopOff),natural:area(loopNatural)},errors},null,2));
  console.log(`Stabilization integration passed (${engine}): jitter reduction, small loops/dots, coalesced and final samples, frozen per-stroke mode, pen lifts, persistence, undo/redo and SVG export.`);
} finally { await browser.close(); }
