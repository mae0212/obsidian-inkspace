import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as esbuild from 'esbuild';

// Exercise the shipped toolbar against the real editor, then against the same
// factory mounted without CodeMirror as it is in the plugin's PDF view.
await esbuild.build({
  entryPoints: ['preview/main.ts'], bundle: true, format: 'iife', target: 'es2020',
  outfile: 'preview/bundle.js',
});
const factoryBundle = await esbuild.build({
  stdin: {
    contents: "import { createToolbar } from './src/toolbar'; import { DEFAULT_SETTINGS } from './src/types'; window.inkspaceToolbarFixture = { createToolbar, DEFAULT_SETTINGS };",
    resolveDir: process.cwd(), sourcefile: 'toolbar-test-fixture.ts',
  }, bundle: true, format: 'iife', target: 'es2020', write: false,
});
const engine = process.env.INKSPACE_BROWSER === 'webkit' ? 'webkit' : 'edge';
const browser = await (engine === 'webkit'
  ? webkit.launch({ headless: true })
  : chromium.launch({ channel: 'msedge', headless: true }));
const context = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
const page = await context.newPage();
const errors = [];
const warnings = [];
const containedPanes = [];
const observe = target => {
  target.on('pageerror', error => errors.push(error.message));
  target.on('console', message => {
    if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(message.text());
    if (message.type() === 'warning') warnings.push(message.text());
  });
};
observe(page);
await fs.mkdir('work/screenshots', { recursive: true });
const settled = async (target = page) => {
  await target.waitForTimeout(100);
  await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
const settings = (target = page) => target.evaluate(() => window.inkspaceTest.host.getSettings());
const setSettings = async (patch, target = page) => {
  await target.evaluate(patch => window.inkspaceTest.host.updateSettings(patch), patch);
  await settled(target);
};
const inkCount = () => page.evaluate(async () => (await window.inkspaceTest.getSession()).document.strokes.length);
const stroke = async (points, id = 123) => {
  await page.evaluate(({ points, id }) => {
    const target = window.inkspaceTest.view.contentDOM;
    points.forEach(([x, y], index) => target.dispatchEvent(new PointerEvent(
      index === 0 ? 'pointerdown' : index === points.length - 1 ? 'pointerup' : 'pointermove',
      { bubbles: true, cancelable: true, pointerId: id, pointerType: 'pen', isPrimary: true,
        button: 0, buttons: index === points.length - 1 ? 0 : 1, clientX: x, clientY: y, pressure: .5 },
    )));
  }, { points, id });
  await settled();
};
const popup = (target = page) => target.getByRole('dialog', { name: 'Stroke size and saved styles', exact: true });
const sizeTrigger = (target = page) => target.getByRole('button', { name: /^Stroke size:/ });
const openSize = async (target = page) => {
  if (!await popup(target).isVisible()) await sizeTrigger(target).tap();
  await popup(target).waitFor({ state: 'visible' });
};
const closeSize = async (target = page) => {
  if (await popup(target).isVisible()) await popup(target).getByRole('button', { name: 'Close stroke size', exact: true }).tap();
  await settled(target);
};
const currentSize = value => value.tool === 'highlighter' ? value.highlighterWidth : value.tool === 'eraser' ? value.eraserSize : value.penWidth;
const assertPopupBounds = async (target, width, height) => {
  await target.setViewportSize({ width, height });
  await settled(target);
  await openSize(target);
  await settled(target);
  const bounds = await popup(target).boundingBox();
  assert.ok(bounds && bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1,
    `Size popup remains usable within ${width}x${height}: ${JSON.stringify(bounds)}`);
  const targets = await popup(target).locator('button, input').evaluateAll(elements => elements
    .filter(element => element.getBoundingClientRect().width && element.getBoundingClientRect().height)
    .map(element => { const rect = element.getBoundingClientRect(); return { label: element.getAttribute('aria-label') ?? element.textContent, width: rect.width, height: rect.height }; }));
  assert.ok(targets.length > 8, 'The touch-size check includes presets, exact size, and saved-style controls');
  for (const hit of targets) assert.ok(hit.width >= 43.9 && hit.height >= 43.9, `Coarse-input target is at least 44x44: ${JSON.stringify(hit)}`);
  const trigger = await sizeTrigger(target).boundingBox();
  assert.ok(trigger.width >= 43.9 && trigger.height >= 43.9, 'Size trigger has a 44x44 touch target');
  assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Toolbar popup adds no page horizontal scrolling');
};

try {
  await page.goto('http://127.0.0.1:4173');
  await page.waitForFunction(() => window.inkspaceTest?.view);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.inkspaceTest?.view);
  await page.evaluate(async () => {
    await window.inkspaceTest.getSession();
    window.inkspaceTest.host.updateSettings({ tool: 'pen', mouseDrawing: false });
  });
  await settled();

  assert.equal(await page.locator('.inkspace-toolbar input[type="range"]').count(), 0, 'Changing stroke width no longer requires a horizontal slider');
  assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true, 'These controls are exercised with coarse touch input');
  assert.equal((await settings()).stabilization, 'natural', 'Fresh handwriting starts with Natural stabilization');

  for (const [tool, property, minimum, maximum, preset] of [
    ['pen', 'penWidth', .5, 32, 5],
    ['highlighter', 'highlighterWidth', 2, 64, 40],
    ['eraser', 'eraserSize', 2, 100, 40],
  ]) {
    await setSettings({ tool, penWidth: 2.5, highlighterWidth: 22, eraserSize: 18 });
    await openSize();
    const before = await settings();
    await popup().getByRole('button', { name: `Set stroke size to ${preset}`, exact: true }).tap();
    const selected = await settings();
    assert.equal(selected[property], preset, `${tool} preset sets its advertised size`);
    for (const other of ['penWidth', 'highlighterWidth', 'eraserSize'].filter(key => key !== property)) assert.equal(selected[other], before[other], `${tool} does not change ${other}`);
    const step = tool === 'pen' ? .5 : 1;
    await setSettings({ [property]: minimum + step });
    await popup().getByRole('button', { name: 'Decrease stroke size', exact: true }).tap();
    assert.equal((await settings())[property], minimum, `${tool} steps down to its minimum`);
    assert.equal(await popup().getByRole('button', { name: 'Decrease stroke size', exact: true }).isDisabled(), true, `${tool} disables stepping below its minimum`);
    await setSettings({ [property]: maximum - step });
    await popup().getByRole('button', { name: 'Increase stroke size', exact: true }).tap();
    assert.equal((await settings())[property], maximum, `${tool} steps up to its maximum`);
    assert.equal(await popup().getByRole('button', { name: 'Increase stroke size', exact: true }).isDisabled(), true, `${tool} disables stepping above its maximum`);
    const field = popup().getByRole('spinbutton', { name: 'Exact stroke size', exact: true });
    assert.equal(await field.getAttribute('min'), String(minimum));
    assert.equal(await field.getAttribute('max'), String(maximum));
    await closeSize();
  }
  for (const tool of ['text', 'lasso']) {
    await setSettings({ tool });
    assert.equal(await sizeTrigger().isVisible(), false, `${tool} hides the inapplicable size control`);
  }

  // Ordinary touch taps must leave the editor's keyboard insertion point intact.
  await setSettings({ tool: 'pen', penWidth: 2.5 });
  const caret = await page.evaluate(() => {
    const view = window.inkspaceTest.view;
    const position = view.state.doc.toString().indexOf('Your words');
    view.focus(); view.dispatch({ selection: { anchor: position } });
    return { position, text: view.state.doc.toString() };
  });
  await openSize();
  await popup().getByRole('button', { name: 'Set stroke size to 5', exact: true }).tap();
  assert.equal(await page.evaluate(() => window.inkspaceTest.view.state.selection.main.head), caret.position, 'A size tap preserves the note caret');
  assert.equal(await page.evaluate(() => window.inkspaceTest.view.hasFocus), true, 'Size preset taps preserve native editor focus');
  await page.keyboard.press('Escape');
  assert.equal(await popup().isVisible(), false, 'Escape dismisses a popup opened while the editor retains focus');
  await closeSize();
  await page.keyboard.insertText('Keyboard still here. ');
  assert.equal(await page.evaluate(() => window.inkspaceTest.view.state.doc.toString()), caret.text.slice(0, caret.position) + 'Keyboard still here. ' + caret.text.slice(caret.position), 'Typing continues at the original caret after tapping size controls');
  assert.equal(await inkCount(), 0, 'Toolbar taps and keyboard typing create no stray ink');

  await openSize();
  const exact = popup().getByRole('spinbutton', { name: 'Exact stroke size', exact: true });
  await exact.fill('4.25');
  await page.waitForTimeout(1050);
  assert.equal(await exact.inputValue(), '4.25', 'A focused unfinished exact value survives the periodic toolbar refresh');
  assert.equal((await settings()).penWidth, 5, 'An unfinished value does not silently alter pen width');
  await exact.press('Enter');
  assert.equal((await settings()).penWidth, 4.25, 'Enter commits an exact decimal size');
  await openSize();
  await exact.fill(''); await exact.press('Enter');
  assert.equal((await settings()).penWidth, 4.25, 'Blank exact input preserves the existing size');
  await exact.fill('7.75'); await exact.press('Escape');
  assert.equal((await settings()).penWidth, 4.25, 'Escape discards an unfinished exact size');
  await openSize();
  assert.equal(await exact.inputValue(), '4.25', 'Reopening displays the committed value after Escape');
  await exact.fill('1000'); await exact.press('Enter');
  assert.ok((await settings()).penWidth >= .5 && (await settings()).penWidth <= 32, 'Out-of-range exact input cannot persist an invalid size');
  await closeSize();

  // Styles are settings snapshots. Capturing/applying them must not restyle old ink.
  await setSettings({ tool: 'pen', color: '#2563eb', penWidth: 2.5 });
  const mark = await page.evaluate(() => {
    const view = window.inkspaceTest.view;
    const point = view.coordsAtPos(view.state.doc.toString().indexOf('Circle an idea'));
    return { x: point.left, y: (point.top + point.bottom) / 2 };
  });
  await stroke([[mark.x, mark.y], [mark.x + 30, mark.y - 8], [mark.x + 60, mark.y]]);
  assert.equal(await inkCount(), 1);
  const originalInk = await page.evaluate(async () => JSON.stringify((await window.inkspaceTest.getSession()).document.strokes));
  await setSettings({ tool: 'pen', color: '#9333ea', penWidth: 3.5, highlighterWidth: 17, highlighterOpacity: .31 });
  await openSize();
  await exact.fill('4.5');
  await popup().getByRole('button', { name: 'Save current style to slot 1', exact: true }).tap();
  let saved = (await settings()).favoriteStyles[0];
  assert.deepEqual({ tool: saved.tool, color: saved.color, width: saved.width }, { tool: 'pen', color: '#9333ea', width: 4.5 }, 'Saving a pen style captures color and the visible exact width draft');
  await setSettings({ tool: 'highlighter', color: '#16a34a', penWidth: 11, highlighterWidth: 31, highlighterOpacity: .41 });
  await popup().getByRole('button', { name: 'Save current style to slot 2', exact: true }).tap();
  saved = (await settings()).favoriteStyles[1];
  assert.deepEqual({ tool: saved.tool, color: saved.color, width: saved.width, opacity: saved.opacity }, { tool: 'highlighter', color: '#16a34a', width: 31, opacity: .41 }, 'Saving a highlighter captures its own width and opacity');
  await setSettings({ color: '#dc2626', highlighterWidth: 7, highlighterOpacity: .1 });
  await popup().getByRole('button', { name: /^Use saved style 1:/ }).tap();
  let restored = await settings();
  assert.deepEqual({ tool: restored.tool, color: restored.color, width: restored.penWidth, otherWidth: restored.highlighterWidth }, { tool: 'pen', color: '#9333ea', width: 4.5, otherWidth: 7 }, 'Applying a pen style preserves the independent highlighter width');
  await popup().getByRole('button', { name: /^Use saved style 2:/ }).tap();
  restored = await settings();
  assert.deepEqual({ tool: restored.tool, color: restored.color, width: restored.highlighterWidth, opacity: restored.highlighterOpacity, otherWidth: restored.penWidth }, { tool: 'highlighter', color: '#16a34a', width: 31, opacity: .41, otherWidth: 4.5 }, 'Applying a highlighter style restores opacity and leaves pen width intact');
  assert.equal(await page.evaluate(async () => JSON.stringify((await window.inkspaceTest.getSession()).document.strokes)), originalInk, 'Saved-style changes never alter existing strokes');

  await closeSize();
  await setSettings({ tool: 'pen' });
  const toolbarBeforeStabilization = await page.locator('.inkspace-toolbar').boundingBox();
  const inkBeforeStabilization = await page.evaluate(async () => JSON.parse(JSON.stringify((await window.inkspaceTest.getSession()).document.strokes)));
  await openSize();
  const stabilization = popup().getByRole('group', { name: 'Handwriting stabilization', exact: true });
  assert.equal(await stabilization.isVisible(), true, 'Freehand pens expose stabilization in the existing popup');
  for (const [value, label] of [['off', 'Off'], ['light', 'Light'], ['natural', 'Natural'], ['strong', 'Strong']]) {
    await stabilization.getByRole('button', { name: `Stabilization: ${label}`, exact: true }).tap();
    assert.equal((await settings()).stabilization, value, `${label} is selected with a single touch tap`);
    assert.equal(await stabilization.locator('button[aria-pressed="true"]').count(), 1, 'Stabilization has exactly one selected level');
    assert.equal(await stabilization.getByRole('button', { name: `Stabilization: ${label}`, exact: true }).getAttribute('aria-pressed'), 'true');
  }
  const toolbarAfterStabilization = await page.locator('.inkspace-toolbar').boundingBox();
  assert.deepEqual(toolbarAfterStabilization, toolbarBeforeStabilization, 'Stabilization adds no permanent toolbar height or width');
  assert.deepEqual(await page.evaluate(async () => (await window.inkspaceTest.getSession()).document.strokes), inkBeforeStabilization, 'Changing stabilization preserves all existing vector ink');
  await closeSize();
  await page.getByRole('button', { name: 'Highlighter', exact: true }).tap();
  await openSize();
  assert.equal(await stabilization.isVisible(), true, 'Freehand highlighting exposes the same stabilization level');
  assert.equal(await stabilization.getByRole('button', { name: 'Stabilization: Strong', exact: true }).getAttribute('aria-pressed'), 'true', 'Switching freehand tools preserves the selected level');
  for (const tool of ['eraser', 'line', 'arrow', 'rectangle', 'ellipse']) {
    await closeSize(); await setSettings({ tool }); await openSize();
    assert.equal(await stabilization.isVisible(), false, `${tool} does not offer an inapplicable handwriting filter`);
  }
  await closeSize();
  await setSettings({ tool: 'pen' });
  await page.evaluate(async () => (await window.inkspaceTest.getSession()).flush());
  await page.reload();
  await page.waitForFunction(() => window.inkspaceTest?.view);
  await page.evaluate(async () => window.inkspaceTest.getSession()); await settled();
  assert.equal((await settings()).stabilization, 'strong', 'The selected handwriting level survives settings save and reload');
  assert.deepEqual(await page.evaluate(async () => (await window.inkspaceTest.getSession()).document.strokes), inkBeforeStabilization, 'Saved ink reopens unchanged after changing stabilization');
  await openSize();
  assert.equal(await stabilization.getByRole('button', { name: 'Stabilization: Strong', exact: true }).getAttribute('aria-pressed'), 'true', 'Reloaded stabilization is reflected by its accessible selected state');

  const touch = await page.evaluate(() => {
    const view = window.inkspaceTest.view;
    const target = document.querySelector('.inkspace-size-trigger');
    const hits = [];
    const types = ['touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointermove', 'pointerup'];
    const listener = event => hits.push(event.type);
    for (const type of types) view.dom.addEventListener(type, listener);
    const point = { identifier: 101, target, clientX: 100, clientY: 100, touchType: 'direct' };
    const makeTouch = (type, touches) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: touches }, targetTouches: { value: touches }, changedTouches: { value: [point] } });
      return event;
    };
    target.dispatchEvent(makeTouch('touchstart', [point]));
    target.dispatchEvent(makeTouch('touchmove', [{ ...point, clientX: 180 }]));
    target.dispatchEvent(makeTouch('touchend', []));
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 101, clientX: type === 'pointerdown' ? 100 : 180, clientY: 100 }));
    const controlHits = hits.slice(); hits.length = 0;
    const finger = makeTouch('touchstart', [{ ...point, target: view.contentDOM }]);
    view.contentDOM.dispatchEvent(finger);
    for (const type of types) view.dom.removeEventListener(type, listener);
    return { controlHits, noteHits: hits, notePrevented: finger.defaultPrevented };
  });
  assert.deepEqual(touch.controlHits, [], 'Toolbar touch/pointer gestures do not reach the editor parent bubble handler');
  assert.deepEqual(touch.noteHits, ['touchstart'], 'An ordinary note finger event still propagates');
  assert.equal(touch.notePrevented, false, 'Single-finger note scrolling remains native');
  assert.equal(await inkCount(), 1, 'Toolbar gestures create no ink');
  await closeSize();

  // Add space uses a normal text transaction; ink anchors and text undo follow it.
  await setSettings({ tool: 'pen' });
  const beforeSpace = await page.evaluate(async () => {
    const t = window.inkspaceTest, view = t.view;
    view.focus(); view.dispatch({ selection: { anchor: view.state.doc.line(3).to } });
    return { text: view.state.doc.toString(), ink: JSON.parse(JSON.stringify((await t.getSession()).document.strokes)) };
  });
  await page.waitForTimeout(600);
  await page.locator('.inkspace-more > summary').tap();
  await page.getByRole('button', { name: 'Add writing space below', exact: true }).tap();
  await settled();
  const afterSpace = await page.evaluate(async () => ({ text: window.inkspaceTest.view.state.doc.toString(), ink: (await window.inkspaceTest.getSession()).document.strokes }));
  assert.equal(afterSpace.text.length, beforeSpace.text.length + 8, 'Writing-space control inserts eight real Markdown line breaks');
  assert.equal(afterSpace.ink[0].anchor.from, beforeSpace.ink[0].anchor.from + 8, 'Existing ink follows its text through writing-space insertion');
  assert.deepEqual(afterSpace.ink[0].points, beforeSpace.ink[0].points, 'Adding writing room does not rewrite vector coordinates');
  await page.keyboard.press('Control+z'); await settled();
  assert.equal(await page.evaluate(() => window.inkspaceTest.view.state.doc.toString()), beforeSpace.text, 'Native text undo removes writing space');
  assert.equal(await page.evaluate(async () => (await window.inkspaceTest.getSession()).document.strokes[0].anchor.from), beforeSpace.ink[0].anchor.from, 'Text undo restores the ink anchor');

  for (const [width, height] of [[820, 1180], [390, 844], [390, 500]]) {
    await assertPopupBounds(page, width, height);
    await page.screenshot({ path: `work/screenshots/toolbar-${engine}-${width}x${height}.png` });
    await closeSize();
  }

  const pdf = await context.newPage(); observe(pdf);
  await pdf.goto('http://127.0.0.1:4173');
  await pdf.waitForFunction(() => window.inkspaceTest?.view);
  await pdf.addScriptTag({ content: factoryBundle.outputFiles[0].text });
  await pdf.evaluate(() => {
    window.inkspaceTest.view.destroy();
    document.body.replaceChildren(); document.body.style.cssText = 'margin:0';
    const shell = document.createElement('main'); shell.className = 'inkspace-pdf-view'; shell.style.height = '100vh';
    const container = document.createElement('div'); container.className = 'inkspace-pdf-toolbar'; shell.append(container); document.body.append(shell);
    let value = structuredClone(window.inkspaceToolbarFixture.DEFAULT_SETTINGS);
    const listeners = new Set();
    const host = { getSettings: () => value, updateSettings: patch => { value = { ...value, ...patch }; for (const listener of listeners) listener(); }, subscribeSettings: listener => { listeners.add(listener); return () => listeners.delete(listener); }, status: () => {} };
    window.inkspaceTest = { host };
    window.inkspaceToolbarFixture.createToolbar(host, container, () => null, { exportPdf: () => {} });
  });
  await settled(pdf);
  await openSize(pdf);
  await popup(pdf).getByRole('button', { name: 'Set stroke size to 5', exact: true }).tap();
  assert.equal(currentSize(await settings(pdf)), 5, 'The standalone PDF toolbar uses the same tap size controls');
  await closeSize(pdf);
  await pdf.locator('.inkspace-more > summary').tap();
  assert.equal(await pdf.getByRole('button', { name: 'Add writing space below', exact: true }).count(), 0, 'The PDF toolbar does not offer Markdown-only writing space');
  assert.equal(await pdf.getByRole('button', { name: 'Export annotated PDF', exact: true }).isVisible(), true, 'The standalone toolbar retains its PDF export action');
  await pdf.locator('.inkspace-more > summary').tap();
  for (const [width, height] of [[820, 1180], [390, 500]]) {
    await assertPopupBounds(pdf, width, height);
    await pdf.screenshot({ path: `work/screenshots/toolbar-pdf-${engine}-${width}x${height}.png` });
    await closeSize(pdf);
  }

  // Obsidian contains and clips each workspace leaf. A fixed popup therefore
  // cannot assume its CSS origin or available space is the browser viewport.
  await pdf.setViewportSize({ width: 1440, height: 1000 });
  for (const pane of [
    { left: 344, top: 40, width: 756, height: 700 },
    { left: 80, top: 90, width: 360, height: 430 },
  ]) {
    await pdf.evaluate(pane => {
      const leaf = document.querySelector('.inkspace-pdf-view');
      leaf.classList.add('workspace-leaf');
      Object.assign(leaf.style, { position: 'absolute', contain: 'strict', overflow: 'hidden',
        left: `${pane.left}px`, top: `${pane.top}px`, width: `${pane.width}px`, height: `${pane.height}px` });
    }, pane);
    await setSettings({ tool: 'pen', penWidth: 2.5 }, pdf);
    await openSize(pdf); await settled(pdf);
    const actual = await popup(pdf).boundingBox();
    const leaf = await pdf.locator('.workspace-leaf').boundingBox();
    assert.ok(actual && actual.x >= leaf.x - 1 && actual.y >= leaf.y - 1
      && actual.x + actual.width <= leaf.x + leaf.width + 1
      && actual.y + actual.height <= leaf.y + leaf.height + 1,
    `Popup stays inside the visible contain:strict leaf, rather than adding its origin twice: ${JSON.stringify({ pane: leaf, popup: actual })}`);
    if (pane.height < 500) {
      const nativePan = await popup(pdf).evaluate(element => {
        element.scrollTop = 0;
        const point = { identifier: 401, target: element, clientX: 180, clientY: 240, touchType: 'direct' };
        const dispatch = (type, touches) => {
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperties(event, { touches: { value: touches }, targetTouches: { value: touches }, changedTouches: { value: [point] } });
          element.dispatchEvent(event); return event;
        };
        dispatch('touchstart', [point]);
        const moving = dispatch('touchmove', [{ ...point, clientY: 190 }]);
        dispatch('touchend', []);
        return { height: element.clientHeight, contentHeight: element.scrollHeight, movePrevented: moving.defaultPrevented };
      });
      assert.ok(nativePan.contentHeight > nativePan.height, 'The expanded controls use vertical scrolling in a short pane');
      assert.equal(nativePan.movePrevented, false, 'Vertical finger movement within popup scroll capacity is left to native scrolling');
      await popup(pdf).hover(); await pdf.mouse.wheel(0, 220); await settled(pdf);
      assert.ok(await popup(pdf).evaluate(element => element.scrollTop > 0), 'The browser can scroll to controls below the short pane fold');
    }
    await popup(pdf).getByRole('button', { name: 'Set stroke size to 5', exact: true }).tap();
    assert.equal((await settings(pdf)).penWidth, 5, 'A clipped pane popup remains physically reachable by touch');
    await popup(pdf).getByRole('button', { name: 'Stabilization: Natural', exact: true }).tap();
    assert.equal((await settings(pdf)).stabilization, 'natural', 'Stabilization remains reachable within a clipped pane');
    const stabilizationTarget = await popup(pdf).getByRole('button', { name: 'Stabilization: Natural', exact: true }).boundingBox();
    assert.ok(stabilizationTarget.x >= leaf.x - 1 && stabilizationTarget.y >= leaf.y - 1
      && stabilizationTarget.x + stabilizationTarget.width <= leaf.x + leaf.width + 1
      && stabilizationTarget.y + stabilizationTarget.height <= leaf.y + leaf.height + 1,
    'The tapped stabilization option is inside the visible clipped pane');
    const field = popup(pdf).getByRole('spinbutton', { name: 'Exact stroke size', exact: true });
    await field.fill('5.75'); await field.press('Enter');
    assert.equal((await settings(pdf)).penWidth, 5.75, 'Exact sizing also works inside the contained leaf');
    containedPanes.push({ pane: leaf, popup: actual });
    await openSize(pdf); await settled(pdf);
    await pdf.screenshot({ path: `work/screenshots/toolbar-contained-${engine}-${pane.width}x${pane.height}.png` });
    await closeSize(pdf);
  }
  await pdf.close();

  assert.deepEqual(errors, [], 'Toolbar interactions produce no runtime or console errors');
  if (engine === 'edge') {
    await page.setViewportSize({ width: 820, height: 1180 });
    await settled(); await openSize(); await settled();
    await page.screenshot({ path: '../inkspace-tablet-controls.png' });
  }
  await fs.writeFile(`work/toolbar-${engine}-result.json`, JSON.stringify({ engine, errors, warnings, containedPanes }, null, 2));
  console.log(`Toolbar integration passed (${engine}): touch controls, focus, independent sizes, saved styles, stabilization persistence and ink preservation, writing space, responsive layout, PDF toolbar, and contained/clipped panes.`);
} catch (error) {
  await fs.writeFile(`work/toolbar-${engine}-result.json`, JSON.stringify({ engine, passed: false, failure: String(error), errors, warnings }, null, 2));
  await page.screenshot({ path: `work/screenshots/toolbar-${engine}-failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
