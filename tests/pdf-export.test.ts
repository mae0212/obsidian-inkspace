import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { exportAnnotatedPdf } from '../src/pdf-export';
import type { Stroke } from '../src/types';

test('annotated PDF preserves original pages, crop boxes, rotations and source bytes', async () => {
  const originalDocument = await PDFDocument.create();
  for (const angle of [0, 90, 180, 270]) {
    const page = originalDocument.addPage([500, 600]);
    page.setCropBox(40, 60, 300, 400);
    page.setRotation(degrees(angle));
    page.drawText('Original content preserved', { x: 90, y: 200, size: 14, color: rgb(0, 0, 0) });
  }
  const original = await originalDocument.save();
  const untouched = original.slice();
  const strokes: Stroke[] = [1, 2, 3, 4].map(page => ({ id: `line-${page}`, tool: 'line', page, points: [{ x: 40, y: 50, pressure: 0.5 }, { x: 140, y: 50, pressure: 0.5 }], color: '#ff0000', width: 8, opacity: 1, updatedAt: 1 }));
  strokes.push({ id: 'outside-page', tool: 'pen', page: 99, points: [{ x: 0, y: 0, pressure: 0.5 }], color: '#000000', width: 2, opacity: 1, updatedAt: 1 });
  const exportedBytes = await exportAnnotatedPdf(original, strokes);
  assert.deepEqual(original, untouched, 'Export must never mutate the original PDF input buffer.');
  const exported = await PDFDocument.load(exportedBytes);
  assert.equal(exported.getPageCount(), 4);
  for (let index = 0; index < 4; index++) {
    assert.deepEqual(exported.getPages()[index].getCropBox(), { x: 40, y: 60, width: 300, height: 400 });
    assert.equal(exported.getPages()[index].getRotation().angle, index * 90);
  }
  // Fixtures also receive a real PDF renderer check in scripts/verify-pdf-export.py.
  await fs.mkdir('work/pdf-export-qa', { recursive: true });
  await fs.writeFile('work/pdf-export-qa/original.pdf', original);
  await fs.writeFile('work/pdf-export-qa/annotated.pdf', exportedBytes);
});

test('PDF exports accept saved pen outlines, translucent highlighters and all shape tools', async () => {
  const original = await PDFDocument.create(); original.addPage([400, 500]);
  const tools = ['pen', 'highlighter', 'line', 'arrow', 'rectangle', 'ellipse'] as const;
  const strokes: Stroke[] = tools.map((tool, index) => ({ id: String(index), tool, points: [{ x: 40, y: 30 + index * 60, pressure: 0.3 }, { x: 160, y: 50 + index * 60, pressure: 0.8 }], color: '#2563eb', width: tool === 'highlighter' ? 20 : 3, opacity: tool === 'highlighter' ? 0.25 : 1, smoothing: 0.6, usePressure: true, updatedAt: 1 }));
  const result = await exportAnnotatedPdf(await original.save(), strokes);
  assert.ok(result.length > 1000);
  assert.equal((await PDFDocument.load(result)).getPageCount(), 1);
  await fs.writeFile('work/pdf-export-qa/all-tools.pdf', result);
});
