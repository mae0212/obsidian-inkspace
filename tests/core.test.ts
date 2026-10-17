import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDocumentLimits, createAnchor, createDocument, hitStroke, INK_LIMITS, InkModel, mapAnchors, polygonContains, reconcileAnchors, shapePoints, strokeBounds, strokePath, strokesToSvg, translateStrokes, validateDocument } from '../src/core';
import type { InkDocument, Stroke } from '../src/types';

const stroke = (patch: Partial<Stroke> = {}): Stroke => ({ id: 'stroke-1', tool: 'pen', points: [{ x: 10, y: 20, pressure: 0.5 }, { x: 110, y: 20, pressure: 0.5 }], color: '#2563eb', width: 4, opacity: 1, updatedAt: 1, ...patch });
const document = (text = ''): InkDocument => ({ ...createDocument('Lecture.md', text), strokes: [stroke()] });

test('document validation makes independent copies and rejects corrupt data without dropping strokes', () => {
  const original = document('Hello');
  const valid = validateDocument(original, 'Lecture.md');
  valid.strokes[0].points[0].x = 100;
  assert.equal(original.strokes[0].points[0].x, 10);
  for (const mutate of [
    (d: any) => d.version = 2,
    (d: any) => d.notePath = 'Other.md',
    (d: any) => d.strokes[0].points[0].x = NaN,
    (d: any) => d.strokes[0].points[0].pressure = 2,
    (d: any) => d.strokes[0].points = [],
    (d: any) => d.strokes[0].color = 'url(evil)',
    (d: any) => d.strokes[0].opacity = -1,
    (d: any) => d.strokes.push(d.strokes[0]),
    (d: any) => d.strokes[0].anchor = { ...createAnchor('Hello', 0, 5, 0, 0), to: 100 },
  ]) {
    const bad = structuredClone(original); mutate(bad);
    assert.throws(() => validateDocument(bad, 'Lecture.md'));
  }
});

test('insertions above ink and text history map anchors without undoing typed text', async () => {
  const text = 'One\nImportant sentence\nEnd';
  const doc = createDocument('Lecture.md', text);
  const saves: InkDocument[] = [];
  const model = new InkModel(doc, async d => { saves.push(d); }, undefined, 100_000);
  model.add([stroke({ anchor: createAnchor(text, 4, 22, 0, 20) })]);
  model.add([stroke({ id: 'second', anchor: createAnchor(text, 4, 22, 0, 20) })]);
  const newText = 'Title\n' + text;
  model.updateText([{ from: 0, to: 0, insert: 'Title\n' }], newText);
  assert.equal(model.document.strokes[0].anchor?.from, 10);
  model.undo();
  assert.equal(model.document.strokes.length, 1);
  assert.equal(model.document.sourceText, newText);
  assert.equal(model.document.strokes[0].anchor?.from, 10);
  model.redo();
  assert.equal(model.document.strokes.length, 2);
  await model.flush();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].sourceText, newText);
});

test('full deletion or replacement preserves ink with an explicit orphan flag', () => {
  const text = 'Above\nTarget phrase\nBelow';
  const s = stroke({ anchor: createAnchor(text, 6, 19, 4, 20) });
  const newText = 'Above\nReplacement\nBelow';
  const mapped = mapAnchors([s], [{ from: 6, to: 19, insert: 'Replacement' }], newText);
  assert.equal(mapped[0].anchor?.orphaned, true);
  assert.equal(mapped[0].anchor?.quote, 'Target phrase');
  assert.equal(mapped[0].points[0].y, 20);
  const again = mapAnchors(mapped, [{ from: 0, to: 0, insert: 'X' }], 'X' + newText);
  assert.equal(again[0].anchor?.orphaned, true);
  assert.equal(s.anchor?.orphaned, undefined);
});

test('external edits relocate unique anchors, disambiguate context, and flag ambiguity', () => {
  const old = 'Alpha.\nA special sentence.\nOmega.';
  const s = stroke({ anchor: createAnchor(old, 7, 26, 0, 10) });
  const moved = reconcileAnchors([s], 'New heading\n' + old)[0];
  assert.equal(moved.anchor?.from, 19);
  assert.equal(moved.anchor?.orphaned, undefined);
  const ambiguous = stroke({ anchor: { from: 1, to: 7, quote: 'Target', prefix: '', suffix: '', x: 0, y: 0 } });
  assert.equal(reconcileAnchors([ambiguous], 'Target and Target')[0].anchor?.orphaned, true);
  const missing = reconcileAnchors([s], 'Entirely changed text')[0];
  assert.equal(missing.anchor?.orphaned, true);
  assert.equal(missing.points.length, 2);
});

test('partial deletion updates the quote while preserving the surviving anchor', () => {
  const text = 'ABCDEF';
  const mapped = mapAnchors([stroke({ anchor: createAnchor(text, 1, 5, 0, 0) })], [{ from: 2, to: 4, insert: '' }], 'ABEF')[0];
  assert.deepEqual({ from: mapped.anchor?.from, to: mapped.anchor?.to, quote: mapped.anchor?.quote, orphaned: mapped.anchor?.orphaned }, { from: 1, to: 3, quote: 'BE', orphaned: undefined });
});

test('external insertion can recover blank-line anchors from unique surrounding text', () => {
  const old = 'Important heading\n\nFollowing paragraph';
  const pos = old.indexOf('\n') + 1;
  const s = stroke({ anchor: createAnchor(old, pos, pos, 0, 40) });
  const shifted = reconcileAnchors([s], 'A new section\n' + old)[0];
  assert.equal(shifted.anchor?.from, pos + 14);
  assert.equal(shifted.anchor?.orphaned, undefined);
});

test('autosaves serialize snapshots and include edits received during a pending save', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const saves: InkDocument[] = [];
  let concurrent = 0, maximum = 0;
  const model = new InkModel(createDocument('Lecture.md'), async d => {
    concurrent++; maximum = Math.max(maximum, concurrent); saves.push(d);
    if (saves.length === 1) await gate;
    concurrent--;
  }, undefined, 100_000);
  model.add([stroke()]);
  const first = model.flush();
  model.add([stroke({ id: 'second' })]);
  const second = model.flush();
  assert.equal(first, second);
  release(); await first;
  assert.equal(maximum, 1);
  assert.equal(saves.length, 2);
  assert.equal(saves[0].strokes.length, 1);
  assert.equal(saves[1].strokes.length, 2);
  assert.equal(model.dirty, false);
});

test('a failed save remains dirty and flush can retry the intact document', async () => {
  let attempts = 0, errors = 0;
  const model = new InkModel(createDocument('Lecture.md'), async () => { if (++attempts === 1) throw new Error('Disk full'); }, () => { errors++; }, 100_000);
  model.add([stroke()]);
  await assert.rejects(model.flush(), /Disk full/);
  assert.equal(model.dirty, true);
  assert.equal(model.document.strokes.length, 1);
  await model.flush();
  assert.equal(errors, 1);
  assert.equal(attempts, 2);
  assert.equal(model.dirty, false);
});

test('pristine text notes create no ink files; deleting the last stroke still saves', async () => {
  let saves = 0;
  const model = new InkModel(createDocument('Lecture.md', 'Hello'), async () => { saves++; }, undefined, 100_000);
  model.updateText([{ from: 5, to: 5, insert: ' there' }], 'Hello there');
  model.reconcileText('New words');
  await model.flush();
  assert.equal(saves, 0);
  model.add([stroke()]); await model.flush();
  model.replace([]); await model.flush();
  assert.equal(saves, 2);
  assert.equal(model.document.strokes.length, 0);
});

test('eraser hits edges, segments and dots while shape interiors remain empty', () => {
  assert.equal(hitStroke(stroke(), { x: 50, y: 21 }, 0), true);
  assert.equal(hitStroke(stroke(), { x: 50, y: 40 }, 3), false);
  const rect = stroke({ tool: 'rectangle', points: shapePoints('rectangle', { x: 0, y: 0, pressure: .5 }, { x: 100, y: 100, pressure: .5 }) });
  assert.equal(hitStroke(rect, { x: 50, y: 50 }, 1), false);
  assert.equal(hitStroke(rect, { x: 100, y: 50 }, 1), true);
  assert.equal(hitStroke(stroke({ points: [{ x: 10, y: 20, pressure: .5 }] }), { x: 11, y: 20 }, 0), true);
  assert.equal(hitStroke(stroke({ tool: 'ellipse', points: [{ x: 0, y: 0, pressure: .5 }, { x: 100, y: 100, pressure: .5 }] }), { x: 50, y: 0 }, 1), true);
});

test('lasso includes boundaries and translation preserves capture anchors without mutating input', () => {
  const polygon = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }];
  assert.equal(polygonContains({ x: 10, y: 10 }, polygon), true);
  assert.equal(polygonContains({ x: 0, y: 30 }, polygon), true);
  assert.equal(polygonContains({ x: 80, y: 30 }, polygon), false);
  const s = stroke({ anchor: createAnchor('Hello', 0, 5, 10, 20) });
  const moved = translateStrokes([s], 20, -5)[0];
  assert.equal(moved.points[0].x, 30);
  assert.equal(s.points[0].x, 10);
  assert.equal(moved.anchor?.x, 10);
  assert.notEqual(moved.anchor, s.anchor);
});

test('SVG exports real vector marks, opacity and escaped attributes', () => {
  const dot = stroke({ points: [{ x: 1, y: 2, pressure: .5 }] });
  assert.match(strokePath(dot), /^M.+Q.+Z$/);
  const svg = strokesToSvg([dot, stroke({ id: 'high', tool: 'highlighter', opacity: .27, width: 22 })], 500, 700, { background: '\"><script>x</script>', offsetX: 5 });
  assert.match(svg, /stroke-width="22"/);
  assert.match(svg, /opacity="0.27"/);
  assert.match(svg, /translate\(5 0\)/);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
  const arrow = stroke({ tool: 'arrow' });
  assert.equal((strokePath(arrow).match(/M/g) ?? []).length, 2);
  assert.match(strokePath(stroke({ tool: 'ellipse' })), /^M.+L/); // Zero-height ellipse is a line.
  assert.equal(strokeBounds(stroke()).width, 104);
});

test('stored pressure and smoothing survive validation and toolbar changes never restyle old ink', () => {
  const s = stroke({ usePressure: true, smoothing: .8, points: [{ x: 0, y: 0, pressure: .1 }, { x: 40, y: 10, pressure: 1 }] });
  const d = document(); d.strokes = [s];
  const valid = validateDocument(d, 'Lecture.md');
  assert.equal(valid.strokes[0].usePressure, true);
  assert.equal(valid.strokes[0].smoothing, .8);
  assert.equal(strokePath(s, { usePressure: false, smoothing: 0 }), strokePath(s, { usePressure: true, smoothing: 1 }));
  const legacy = stroke();
  assert.equal(strokePath(legacy, { usePressure: false }), strokePath(legacy, { usePressure: true }));
  assert.notEqual(strokePath(s), strokePath({ ...s, usePressure: false }));
});

test('the last supported stroke is accepted, but one extra stroke cannot change ink or its undo history', async () => {
  const model = new InkModel(createDocument('Lecture.md'), async d => { assertDocumentLimits(d); }, undefined, 100_000);
  const marks = Array.from({ length: INK_LIMITS.strokes }, (_, i) => stroke({ id: String(i), points: [{ x: 0, y: 0, pressure: .5 }] }));
  model.replace(marks);
  assert.equal(model.document.strokes.length, INK_LIMITS.strokes);
  const revision = model.document.revision;
  assert.throws(() => model.add([stroke({ id: 'one-too-many' })]), /100,000 strokes/);
  assert.equal(model.document.strokes.length, INK_LIMITS.strokes);
  assert.equal(model.document.revision, revision);
  model.undo();
  assert.equal(model.document.strokes.length, 0); // A rejected mutation did not insert an extra undo state.
  await model.flush();
});

test('per-stroke and aggregate point limits match load validation without dropping previous marks', async () => {
  const point = { x: 0, y: 0, pressure: .5 };
  const fullStroke = stroke({ points: Array(INK_LIMITS.pointsPerStroke).fill(point) });
  const atLimit = createDocument('Lecture.md');
  atLimit.strokes = Array.from({ length: INK_LIMITS.totalPoints / INK_LIMITS.pointsPerStroke }, (_, i) => ({ ...fullStroke, id: String(i) }));
  assert.doesNotThrow(() => assertDocumentLimits(atLimit));
  const model = new InkModel(document(), async () => {}, undefined, 100_000);
  const before = model.document;
  assert.throws(() => model.replace([...atLimit.strokes, stroke({ id: 'extra', points: [point] })]), /2,000,000 points/);
  assert.equal(model.document, before);
  assert.throws(() => model.replace([stroke({ points: Array(INK_LIMITS.pointsPerStroke + 1).fill(point) })]), /250,000 points/);
  assert.equal(model.document, before);
  assert.equal(model.canUndo, false);
  await model.flush();
});

test('invalid moved marks and duplicate ids preserve the complete state and redo branch', async () => {
  const model = new InkModel(createDocument('Lecture.md'), async d => { assertDocumentLimits(d); }, undefined, 100_000);
  model.add([stroke()]); model.add([stroke({ id: 'second' })]); model.undo();
  const before = JSON.stringify(model.document);
  for (const patch of [
    { points: [{ x: INK_LIMITS.coordinate + 1, y: 0, pressure: .5 }] },
    { points: [{ x: 0, y: -INK_LIMITS.coordinate - 1, pressure: .5 }] },
    { points: [{ x: 0, y: 0, pressure: 1.1 }] },
    { points: [{ x: Infinity, y: 0, pressure: .5 }] },
    { color: 'url(bad)' },
  ] as Partial<Stroke>[]) {
    assert.throws(() => model.replace([stroke(patch)]));
    assert.equal(JSON.stringify(model.document), before);
    assert.equal(model.canRedo, true);
  }
  assert.throws(() => model.add([stroke()]), /duplicate stroke ids/);
  assert.equal(JSON.stringify(model.document), before);
  model.redo();
  assert.deepEqual(model.document.strokes.map(s => s.id), ['stroke-1', 'second']);
  const boundary = document(); boundary.strokes[0].points = [{ x: INK_LIMITS.coordinate, y: -INK_LIMITS.coordinate, pressure: 1 }];
  assert.doesNotThrow(() => assertDocumentLimits(boundary));
  await model.flush();
});

test('oversized text remains editable while ink save refuses unreadable snapshots and can recover', async () => {
  const saves: InkDocument[] = [], errors: Error[] = [];
  const text = 'target', prefix = 'x'.repeat(INK_LIMITS.sourceChars);
  assert.doesNotThrow(() => assertDocumentLimits(createDocument('Lecture.md', prefix)));
  const model = new InkModel(createDocument('Lecture.md', text), async d => { saves.push(d); }, error => { errors.push(error); }, 100_000);
  model.add([stroke({ anchor: createAnchor(text, 0, 6, 0, 0) })]); await model.flush();
  assert.doesNotThrow(() => model.updateText([{ from: 0, to: 0, insert: prefix }], prefix + text));
  assert.equal(model.document.sourceText.length, INK_LIMITS.sourceChars + text.length);
  assert.equal(model.document.strokes.length, 1);
  await assert.rejects(model.flush(), /10,000,000 characters/);
  assert.equal(saves.length, 1); // The last readable on-disk document was never replaced.
  assert.equal(saves[0].sourceText, text);
  assert.equal(errors.length, 1);
  assert.equal(model.dirty, true);
  model.updateText([{ from: 0, to: prefix.length, insert: '' }], text);
  await model.flush();
  assert.equal(saves.length, 2);
  assert.equal(model.dirty, false);
  assert.equal(validateDocument(saves[1], 'Lecture.md').strokes[0].anchor?.from, 0);
});

test('the final write guard rejects invalid live state even if a caller bypasses mutation methods', async () => {
  let saves = 0, errors = 0;
  const model = new InkModel(createDocument('Lecture.md'), async () => { saves++; }, () => { errors++; }, 100_000);
  model.add([stroke()]);
  model.document.strokes[0].points[0].x = NaN;
  await assert.rejects(model.flush(), /point x/);
  assert.equal(saves, 0); assert.equal(errors, 1); assert.equal(model.dirty, true);
  model.document.strokes[0].points[0].x = 10;
  await model.flush();
  assert.equal(saves, 1); assert.equal(model.dirty, false);
});
