import { PDFDocument, degrees, rgb, type PDFPage } from 'pdf-lib';
import { strokePath } from './core';
import type { Stroke } from './types';

/** Preserve all original PDF pages/content and add ink as real vector paths. */
export async function exportAnnotatedPdf(original: ArrayBuffer | Uint8Array, strokes: Stroke[]): Promise<Uint8Array> {
  const document = await PDFDocument.load(original);
  const pages = document.getPages();
  const grouped = new Map<number, Stroke[]>();
  for (const stroke of strokes) {
    const index = (stroke.page || 1) - 1;
    if (!pages[index] || !stroke.points.length) continue;
    if (!grouped.has(index)) grouped.set(index, []);
    grouped.get(index)!.push(stroke);
  }
  for (const [index, pageStrokes] of grouped) {
    const page = pages[index], crop = page.getCropBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    if (rotation === 0) {
      for (const stroke of pageStrokes) drawInk(page, stroke, crop.x, crop.y + crop.height);
      continue;
    }
    const sideways = rotation === 90 || rotation === 270;
    const visibleWidth = sideways ? crop.height : crop.width;
    const visibleHeight = sideways ? crop.width : crop.height;
    // One vector layer per rotated page keeps large notebooks practical.
    const layerDocument = await PDFDocument.create();
    const layerPage = layerDocument.addPage([visibleWidth, visibleHeight]);
    for (const stroke of pageStrokes) drawInk(layerPage, stroke, 0, visibleHeight);
    const [layer] = await document.embedPdf(layerDocument, [0]);
    // Coordinates in Inkspace are PDF.js viewport coordinates (top left).
    // These inverse transforms retain alignment with /CropBox and /Rotate.
    if (rotation === 90) page.drawPage(layer, { x: crop.x + crop.width, y: crop.y, rotate: degrees(90) });
    else if (rotation === 180) page.drawPage(layer, { x: crop.x + crop.width, y: crop.y + crop.height, rotate: degrees(180) });
    else if (rotation === 270) page.drawPage(layer, { x: crop.x, y: crop.y + crop.height, rotate: degrees(270) });
    else throw new Error('This PDF uses an unsupported page rotation.');
  }
  return document.save();
}
function drawInk(page: PDFPage, stroke: Stroke, x: number, y: number): void {
  const path = strokePath(stroke);
  if (!path) return;
  const [r, g, b] = parseColor(stroke.color), color = rgb(r, g, b);
  page.drawSvgPath(path, { x, y, ...(stroke.tool === 'pen' ? { color } : { borderColor: color, borderWidth: stroke.width }), opacity: stroke.opacity, borderOpacity: stroke.opacity });
}
function parseColor(hex: string): [number, number, number] {
  let value = hex.replace(/^#/, '');
  if (value.length === 3 || value.length === 4) value = [...value.slice(0, 3)].map(c => c + c).join('');
  if (!/^[\da-f]{6}([\da-f]{2})?$/i.test(value)) value = '2563eb';
  return [parseInt(value.slice(0, 2), 16) / 255, parseInt(value.slice(2, 4), 16) / 255, parseInt(value.slice(4, 6), 16) / 255];
}
