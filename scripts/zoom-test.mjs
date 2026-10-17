import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as esbuild from 'esbuild';
await esbuild.build({entryPoints:['preview/main.ts'],bundle:true,format:'iife',target:'es2020',outfile:'preview/bundle.js'});
const browser=await (process.env.INKSPACE_BROWSER==='webkit'?webkit.launch({headless:true}):chromium.launch({channel:'msedge',headless:true}));
const page=await browser.newPage({viewport:{width:1440,height:1050}});
const errors=[]; page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='warning'&&/Measure loop|Viewport failed/.test(message.text()))errors.push(message.text());});
const settled=async()=>{await page.waitForTimeout(120);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
await page.goto('http://127.0.0.1:4173');await page.evaluate(()=>localStorage.clear());await page.reload();
await page.waitForFunction(()=>window.inkspaceTest?.view);await page.evaluate(async()=>{await window.inkspaceTest.getSession();window.inkspaceTest.host.updateSettings({mouseDrawing:false});});await settled();
const count=()=>page.evaluate(async()=>(await window.inkspaceTest.getSession()).document.strokes.length);
const coordinates=()=>page.evaluate(()=>{const t=window.inkspaceTest;const pos=t.view.state.doc.toString().indexOf('Circle an idea');const p=t.view.coordsAtPos(pos);return{x:p.left,y:(p.top+p.bottom)/2};});
const stroke=async(points,tool='pen',id=80)=>{await page.evaluate(({points,tool,id})=>{const t=window.inkspaceTest;t.host.updateSettings({tool});points.forEach(([x,y],i)=>t.view.contentDOM.dispatchEvent(new PointerEvent(i===0?'pointerdown':i===points.length-1?'pointerup':'pointermove',{bubbles:true,cancelable:true,pointerId:id,pointerType:'pen',isPrimary:true,button:0,buttons:i===points.length-1?0:1,clientX:x,clientY:y,pressure:.5})));},{points,tool,id});await settled();};
const bounds=()=>page.evaluate(()=>{const c=document.querySelector('.inkspace-saved-ink'),d=c.getContext('2d').getImageData(0,0,c.width,c.height);let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,n=0;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++)if(d.data[(y*c.width+x)*4+3]>20){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);n++;}return{minX,minY,maxX,maxY,n};});
let p=await coordinates();await stroke([[p.x,p.y],[p.x+40,p.y],[p.x+80,p.y]],'line');
assert.equal(await count(),1);
const original=await page.evaluate(async()=>JSON.stringify((await window.inkspaceTest.getSession()).document.strokes));
for(const zoom of [.6,1.4,1]){
  await page.evaluate(zoom=>window.inkspaceTest.host.updateSettings({zoom}),zoom);await settled();
  await page.evaluate(()=>{const t=window.inkspaceTest;t.view.dispatch({selection:{anchor:t.view.state.doc.toString().indexOf('Circle an idea')},scrollIntoView:true});});await settled();
  const measured=await bounds();
  const expected=await page.evaluate(async()=>{const t=window.inkspaceTest,s=(await t.getSession()).document.strokes[0],a=s.anchor,c=t.view.coordsAtPos(a.from),r=t.view.scrollDOM.getBoundingClientRect(),z=t.host.getSettings().zoom;return{x:c.left-r.left+(Math.min(...s.points.map(p=>p.x))-a.x)*z,y:c.top-r.top+(Math.min(...s.points.map(p=>p.y))-a.y)*z,width:80*z};});
  assert.ok(Math.abs(measured.minX-expected.x)<4,`Zoom ${zoom}: ink x follows text (${JSON.stringify(measured)},${JSON.stringify(expected)})`);
  assert.ok(Math.abs(measured.minY-expected.y)<4,`Zoom ${zoom}: ink y follows text (${measured.minY},${expected.y})`);
  assert.ok(Math.abs(measured.maxX-measured.minX-expected.width)<5,`Zoom ${zoom}: ink itself scales`);
  assert.equal(await page.evaluate(async()=>JSON.stringify((await window.inkspaceTest.getSession()).document.strokes)),original,'Zoom never modifies saved strokes');
  await page.evaluate(()=>{const style=document.createElement('style');style.id='raster-probe';style.textContent='.cm-content .cm-line:first-child{background:rgb(12,222,67)!important}';document.head.append(style);window.inkspaceTest.view.scrollDOM.scrollTop=0;});await settled();
  const textBox=await page.locator('.cm-content .cm-line').first().boundingBox();
  const screenshot=await page.screenshot();
  const raster=await page.evaluate(async base64=>{const image=new Image();image.src=`data:image/png;base64,${base64}`;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;let x1=Infinity,y1=Infinity,x2=-Infinity,y2=-Infinity;for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){const i=(y*canvas.width+x)*4;if(Math.abs(data[i]-12)<3&&Math.abs(data[i+1]-222)<3&&Math.abs(data[i+2]-67)<3){x1=Math.min(x1,x);y1=Math.min(y1,y);x2=Math.max(x2,x);y2=Math.max(y2,y);}}return{x:x1,y:y1,width:x2-x1+1,height:y2-y1+1};},screenshot.toString('base64'));
  assert.ok(Math.abs(raster.x-textBox.x)<2&&Math.abs(raster.y-textBox.y)<2&&Math.abs(raster.width-textBox.width)<3&&Math.abs(raster.height-textBox.height)<3,`Zoom ${zoom}: actual typed-line screenshot raster matches DOM geometry (${JSON.stringify(raster)} / ${JSON.stringify(textBox)})`);
  await page.evaluate(()=>document.querySelector('#raster-probe').remove());
}
await page.evaluate(()=>window.inkspaceTest.host.updateSettings({zoom:.6}));await settled();p=await coordinates();
await stroke([[p.x,p.y+25],[p.x+48,p.y+25]],'line',81);
const newStroke=await page.evaluate(async()=>(await window.inkspaceTest.getSession()).document.strokes.at(-1));
assert.ok(Math.abs(newStroke.points[1].x-newStroke.points[0].x-80)<.01,'A stroke drawn at 60% retains 80 logical px');
await page.evaluate(()=>window.inkspaceTest.host.updateSettings({zoom:1}));await settled();
assert.deepEqual(await page.evaluate(async()=>(await window.inkspaceTest.getSession()).document.strokes.at(-1)),newStroke,'Returning to 100% preserves the new stroke exactly');
await page.evaluate(()=>{const t=window.inkspaceTest;t.view.dispatch({changes:{from:0,insert:'A line above\n\n'}});});await settled();
await page.evaluate(()=>window.inkspaceTest.host.updateSettings({zoom:.6}));await settled();
const erasePoint=await page.evaluate(async()=>{const t=window.inkspaceTest,s=(await t.getSession()).document.strokes[0],a=s.anchor,c=t.view.coordsAtPos(a.from),z=t.host.getSettings().zoom;return{x:c.left+(s.points[0].x+40-a.x)*z,y:c.top+(s.points[0].y-a.y)*z};});
await stroke([[erasePoint.x,erasePoint.y],[erasePoint.x+.1,erasePoint.y]],'eraser',82);assert.equal(await count(),1,'Eraser hits translated ink at 60% after text insertion');
await page.evaluate(()=>window.inkspaceTest.host.updateSettings({zoom:1,tool:'pen'}));await settled();
const pinch=await page.evaluate(()=>{const t=window.inkspaceTest,target=t.view.contentDOM,r=t.view.scrollDOM.getBoundingClientRect(),x=r.left+300,y=r.top+250;const touches=(distance)=>[{identifier:1,target,clientX:x-distance/2,clientY:y,touchType:'direct'},{identifier:2,target,clientX:x+distance/2,clientY:y,touchType:'direct'}];const touchEvent=(type,current,changed)=>{const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperties(event,{touches:{value:current},targetTouches:{value:current},changedTouches:{value:changed}});return event;};const start=touchEvent('touchstart',touches(100),touches(100));target.dispatchEvent(start);const move=touchEvent('touchmove',touches(140),touches(140));target.dispatchEvent(move);target.dispatchEvent(touchEvent('touchend',[],touches(140)));const point={identifier:3,target,clientX:x,clientY:y,touchType:'direct'},finger=touchEvent('touchstart',[point],[point]);target.dispatchEvent(finger);return{zoom:t.host.getSettings().zoom,start:start.defaultPrevented,move:move.defaultPrevented,finger:finger.defaultPrevented};});await settled();
assert.ok(Math.abs(pinch.zoom-1.4)<.001,'Two-finger pinch changes actual document zoom');assert.equal(pinch.start,true);assert.equal(pinch.move,true);assert.equal(pinch.finger,false,'Single-finger scrolling remains native');
await page.evaluate(()=>window.inkspaceTest.host.updateSettings({zoom:.6,tool:'lasso'}));await settled();
await page.evaluate(async()=>{const t=window.inkspaceTest,s=(await t.getSession()).document.strokes[0];t.view.dispatch({selection:{anchor:s.anchor?.from??0},scrollIntoView:true});});await settled();
await page.evaluate(()=>{const scroller=window.inkspaceTest.view.scrollDOM;scroller.scrollTop=Math.max(0,scroller.scrollTop-scroller.clientHeight/3);});await settled();
let ink=await bounds();const rect=await page.locator('.cm-scroller').boundingBox();
assert.ok(ink.n>0,`The test brings the selected stroke into the visible viewport: ${JSON.stringify(await page.evaluate(async()=>{const t=window.inkspaceTest,v=t.view,s=(await t.getSession()).document.strokes[0],r=e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,w:b.width,h:b.height}};return{s,coords:v.coordsAtPos(s.anchor?.from??0),content:r(v.contentDOM),scroller:r(v.scrollDOM),scrollLeft:v.scrollDOM.scrollLeft,scrollTop:v.scrollDOM.scrollTop,scale:v.scaleY,style:v.contentDOM.style.cssText};}))}`);
let selection={x:rect.x+ink.minX,y:rect.y+ink.minY,width:ink.maxX-ink.minX,height:ink.maxY-ink.minY};
await stroke([[selection.x-12,selection.y-12],[selection.x+selection.width+12,selection.y-12],[selection.x+selection.width+12,selection.y+selection.height+12],[selection.x-12,selection.y+selection.height+12],[selection.x-12,selection.y-12]],'lasso',83);
assert.match(await page.locator('.inkspace-selection-hint').textContent(),/1 selected/,'Lasso selects translated/zoomed ink');
const beforeMove=await bounds();const center=[selection.x+selection.width/2,selection.y+selection.height/2];
await stroke([center,[center[0]+24,center[1]+12]],'lasso',84);
const afterMove=await bounds();assert.ok(Math.abs(afterMove.minX-beforeMove.minX-24)<3,'Lasso move uses zoom-normalized x');assert.ok(Math.abs(afterMove.minY-beforeMove.minY-12)<3,'Lasso move uses zoom-normalized y');
await page.getByRole('button',{name:'Copy',exact:true}).click();await settled();assert.equal(await count(),2,'Copy works after zoomed lasso move');
await page.getByRole('button',{name:'Delete',exact:true}).click();await settled();assert.equal(await count(),1,'Delete affects only copied selection');
const exports=[];
const exportStates=[];
for(const zoom of [.6,1]){await page.evaluate(zoom=>window.inkspaceTest.host.updateSettings({zoom}),zoom);await settled();exportStates.push(await page.evaluate(async()=>{const t=window.inkspaceTest,v=t.view,s=(await t.getSession()).document.strokes[0],a=s.anchor,r=v.contentDOM.getBoundingClientRect();return{z:t.host.getSettings().zoom,anchor:a,point:s.points[0],coords:v.coordsAtPos(a.from),content:{left:r.left,top:r.top,width:r.width,height:r.height},classes:v.dom.className};}));await page.locator('.inkspace-more > summary').click();const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Export ink as SVG',exact:true}).click();const download=await downloading;exports.push(await fs.readFile(await download.path(),'utf8'));}
const vectorNumbers=svg=>[...svg.matchAll(/<path d="([^"]*)"/g)].flatMap(match=>match[1].match(/-?\d+(?:\.\d+)?/g).map(Number));
// CSS zoom changes text raster metrics by fractions of a CSS pixel in both engines.
// Export follows those live anchors, while stroke dimensions and persisted points remain exact.
const vectorA=vectorNumbers(exports[0]),vectorB=vectorNumbers(exports[1]);assert.equal(vectorA.length,vectorB.length,'Zoom does not change exported vector topology');assert.ok(vectorA.every((value,index)=>Math.abs(value-vectorB[index])<1),`SVG coordinates stay within subpixel text-layout rounding across zoom: ${JSON.stringify(vectorA)} / ${JSON.stringify(vectorB)} states=${JSON.stringify(exportStates)}`);
for(const width of [820,390]){await page.setViewportSize({width,height:1050});await settled();await page.evaluate(()=>{window.inkspaceTest.view.scrollDOM.scrollTop=0;window.inkspaceTest.view.scrollDOM.scrollLeft=0;});await settled();const layout=await page.evaluate(()=>{const t=window.inkspaceTest,toolbar=document.querySelector('.inkspace-toolbar').getBoundingClientRect(),first=t.view.coordsAtPos(0);return{toolbarBottom:toolbar.bottom,textTop:first.top};});assert.ok(layout.textTop>=layout.toolbarBottom-1,`At ${width}px, the measured toolbar does not cover note text (${layout.textTop}, ${layout.toolbarBottom})`);}
await page.evaluate(()=>window.inkspaceTest.host.updateSettings({enabled:false}));await settled();assert.equal(await page.evaluate(()=>window.inkspaceTest.view.contentDOM.style.getPropertyValue('zoom')),'','Disabling the plugin restores original content zoom');
await page.evaluate(()=>window.inkspaceTest.host.updateSettings({enabled:true,zoom:1.4}));await settled();assert.ok(Math.abs(await page.evaluate(()=>{const content=window.inkspaceTest.view.contentDOM;return content.getBoundingClientRect().width/content.offsetWidth;})-1.4)<.02,'Re-enabling restores chosen document zoom');
const destroyed=await page.evaluate(()=>{const t=window.inkspaceTest,content=t.view.contentDOM;t.view.destroy();return{zoom:content.style.getPropertyValue('zoom'),transform:content.style.transform,overlays:document.querySelectorAll('.inkspace-overlay').length};});assert.equal(destroyed.zoom,'','Unload restores original content zoom');assert.equal(destroyed.transform,'','Unload restores original content transform');assert.equal(destroyed.overlays,0,'Unload removes ink layers');
assert.deepEqual(errors,[]);
await browser.close();console.log('Zoom verified: 60/100/140% ink/text alignment, persisted vector and SVG invariance, canonical new strokes, translated erasing/lasso/copy/delete, two-finger pinch, single-finger native input, responsive toolbar clearance, disable/unload restores original zoom.');

