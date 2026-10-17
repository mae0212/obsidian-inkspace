import { getStroke } from 'perfect-freehand';
import { DEFAULT_SETTINGS, type Anchor, type InkDocument, type InkSession, type InkSettings, type Point, type Stroke, type StrokeTool, type TextChange, type Tool } from './types';

type XY = { x: number; y: number };
export interface Bounds extends XY { width: number; height: number; minX: number; minY: number; maxX: number; maxY: number }
export const INK_LIMITS = Object.freeze({ coordinate: 1_000_000, sourceChars: 10_000_000, strokes: 100_000, pointsPerStroke: 250_000, totalPoints: 2_000_000 });
const LIMIT = INK_LIMITS.coordinate;
const TOOLS = new Set<StrokeTool>(['pen', 'highlighter', 'line', 'arrow', 'rectangle', 'ellipse']);
let nextId = 0;
export function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `ink-${Date.now().toString(36)}-${(++nextId).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
export function createDocument(path: string, text = ''): InkDocument {
  return { version: 1, notePath: path, sourceText: text, revision: 0, updatedAt: Date.now(), strokes: [] };
}
const cloneStroke = (s: Stroke): Stroke => ({ ...s, points: s.points.map(p => ({ ...p })), ...(s.anchor ? { anchor: { ...s.anchor } } : {}) });
const cloneStrokes = (ss: Stroke[]) => ss.map(cloneStroke);
const cloneDocument = (d: InkDocument): InkDocument => ({ ...d, strokes: cloneStrokes(d.strokes) });
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid Inkspace file: ${name} must be an object.`);
  return value as Record<string, unknown>;
}
function number(value: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error(`Invalid Inkspace file: ${name} is outside its supported range.`);
  return value;
}
function string(value: unknown, name: string, max: number, min = 0): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.includes('\0')) throw new Error(`Invalid Inkspace file: ${name} must be valid text.`);
  return value;
}
function validateStrokes(input: unknown, sourceLength: number, copy: boolean, trusted?: ReadonlySet<Stroke>): Stroke[] {
  if (!Array.isArray(input) || input.length > INK_LIMITS.strokes) throw new Error(`Inkspace supports at most ${INK_LIMITS.strokes.toLocaleString('en-US')} strokes per note. Existing ink was preserved.`);
  const ids = new Set<string>();
  let pointCount = 0;
  // Check all collection capacities before cloning any of the proposed data.
  for (const entry of input) {
    const s = object(entry, 'stroke');
    if (!Array.isArray(s.points) || !s.points.length || s.points.length > INK_LIMITS.pointsPerStroke) throw new Error(`Inkspace strokes must contain between 1 and ${INK_LIMITS.pointsPerStroke.toLocaleString('en-US')} points. Existing ink was preserved.`);
    pointCount += s.points.length;
    if (pointCount > INK_LIMITS.totalPoints) throw new Error(`Inkspace supports at most ${INK_LIMITS.totalPoints.toLocaleString('en-US')} points per note. Existing ink was preserved.`);
  }
  return input.map((entry, i): Stroke => {
    const s = object(entry, `stroke ${i}`);
    const id = string(s.id, 'stroke id', 256, 1);
    if (ids.has(id)) throw new Error('Invalid Inkspace file: duplicate stroke ids.');
    ids.add(id);
    // Model-owned strokes are immutable. Existing point arrays need no rescan on each new mark.
    if (trusted?.has(entry as Stroke)) return entry as Stroke;
    if (!TOOLS.has(s.tool as StrokeTool)) throw new Error('Invalid Inkspace file: unsupported stroke tool.');
    const sourcePoints = s.points as unknown[];
    const points = copy ? [] as Point[] : sourcePoints as Point[];
    for (const entry of sourcePoints) {
      const p = object(entry, 'point');
      const x = number(p.x, 'point x', -LIMIT, LIMIT), y = number(p.y, 'point y', -LIMIT, LIMIT), pressure = number(p.pressure, 'pressure', 0, 1);
      const t = p.t === undefined ? undefined : number(p.t, 'point time', 0, Number.MAX_SAFE_INTEGER);
      if (copy) points.push({ x, y, pressure, ...(t === undefined ? {} : { t }) });
    }
    if (s.tool !== 'pen' && s.tool !== 'highlighter' && points.length < 2) throw new Error('Invalid Inkspace file: shapes need two endpoints.');
    const color = string(s.color, 'color', 16, 4);
    if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) throw new Error('Invalid Inkspace file: invalid stroke color.');
    let anchor: Anchor | undefined;
    if (s.anchor !== undefined) {
      const a = object(s.anchor, 'anchor');
      const from = number(a.from, 'anchor start', 0, sourceLength, true);
      const to = number(a.to, 'anchor end', from, sourceLength, true);
      if (a.orphaned !== undefined && typeof a.orphaned !== 'boolean') throw new Error('Invalid Inkspace file: invalid orphan flag.');
      anchor = { from, to, quote: string(a.quote, 'anchor quote', INK_LIMITS.sourceChars), prefix: string(a.prefix, 'anchor prefix', 128), suffix: string(a.suffix, 'anchor suffix', 128), x: number(a.x, 'anchor x', -LIMIT, LIMIT), y: number(a.y, 'anchor y', -LIMIT, LIMIT), ...(a.orphaned !== undefined ? { orphaned: a.orphaned } : {}) };
    }
    if (s.usePressure !== undefined && typeof s.usePressure !== 'boolean') throw new Error('Invalid Inkspace file: invalid pressure setting.');
    const width = number(s.width, 'stroke width', 0.1, 512), opacity = number(s.opacity, 'stroke opacity', 0, 1), updatedAt = number(s.updatedAt, 'stroke timestamp', 0, Number.MAX_SAFE_INTEGER);
    const page = s.page === undefined ? undefined : number(s.page, 'page', 0, 1_000_000, true);
    const smoothing = s.smoothing === undefined ? undefined : number(s.smoothing, 'smoothing', 0, 1);
    return copy ? { id, tool: s.tool as StrokeTool, points, color, width, opacity, updatedAt, ...(anchor ? { anchor } : {}), ...(page === undefined ? {} : { page }), ...(smoothing === undefined ? {} : { smoothing }), ...(s.usePressure !== undefined ? { usePressure: s.usePressure as boolean } : {}) } : entry as Stroke;
  });
}
/** Reject corruption rather than silently deleting marks while loading. */
export function validateDocument(input: unknown, path: string, copy = true): InkDocument {
  const d = object(input, 'document');
  if (d.version !== 1) throw new Error('Unsupported Inkspace file version. The original file has been preserved.');
  const notePath = string(d.notePath, 'notePath', 4096, 1);
  if (notePath !== path) throw new Error('Inkspace file belongs to a different note. The original file has been preserved.');
  const sourceText = string(d.sourceText, 'sourceText', INK_LIMITS.sourceChars);
  const strokes = validateStrokes(d.strokes, sourceText.length, copy);
  return { version: 1, notePath, sourceText, revision: number(d.revision, 'revision', 0, Number.MAX_SAFE_INTEGER, true), updatedAt: number(d.updatedAt, 'document timestamp', 0, Number.MAX_SAFE_INTEGER), strokes };
}
/** Full final write guard. Validates existing point arrays without cloning them. */
export function assertDocumentLimits(document: InkDocument): void {
  if (document.sourceText.length > INK_LIMITS.sourceChars) throw new Error(`Inkspace cannot save annotations while this note exceeds ${INK_LIMITS.sourceChars.toLocaleString('en-US')} characters. Text editing remains available; existing ink and the last saved file are preserved. Shorten or split the note, then retry Save ink.`);
  validateDocument(document, document.notePath, false);
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
export function createAnchor(text: string, from: number, to: number, x: number, y: number): Anchor {
  from = clamp(Math.floor(from), 0, text.length);
  to = clamp(Math.floor(to), from, text.length);
  return { from, to, quote: text.slice(from, to), prefix: text.slice(Math.max(0, from - 64), from), suffix: text.slice(to, to + 64), x, y };
}
function mapPosition(pos: number, changes: TextChange[], association: -1 | 1): number {
  let offset = 0;
  for (const c of changes) {
    if (pos < c.from || (pos === c.from && association < 0)) break;
    if (pos > c.to || (pos === c.to && c.from !== c.to)) offset += c.insert.length - (c.to - c.from);
    else return c.from + offset + (association > 0 ? c.insert.length : 0);
  }
  return pos + offset;
}
/** Changes use positions in the OLD text, as CodeMirror ChangeSet.iterChanges does. */
export function mapAnchors(strokes: Stroke[], changes: TextChange[], newText: string): Stroke[] {
  const sorted = [...changes].sort((a, b) => a.from - b.from || a.to - b.to);
  return strokes.map(stroke => {
    const a = stroke.anchor;
    if (!a) return stroke;
    const s = { ...stroke };
    const deleted = sorted.reduce((n, c) => n + Math.max(0, Math.min(c.to, a.to) - Math.max(c.from, a.from)), 0);
    const orphaned = a.orphaned || (a.to > a.from && deleted >= a.to - a.from) || (a.to === a.from && sorted.some(c => c.from < a.from && c.to > a.from));
    const from = clamp(mapPosition(a.from, sorted, 1), 0, newText.length);
    const to = clamp(mapPosition(a.to, sorted, -1), from, newText.length);
    s.anchor = orphaned ? { ...a, from, to, orphaned: true } : { ...createAnchor(newText, from, to, a.x, a.y), ...(a.orphaned === false ? { orphaned: false } : {}) };
    return s;
  });
}
function contextScore(text: string, pos: number, a: Anchor): number {
  let score = 0;
  for (let i = 1; i <= a.prefix.length && i <= pos; i++) { if (text[pos - i] !== a.prefix[a.prefix.length - i]) break; score++; }
  for (let i = 0; i < a.suffix.length && pos + a.quote.length + i < text.length; i++) { if (text[pos + a.quote.length + i] !== a.suffix[i]) break; score++; }
  return score;
}
/** Conservative recovery after an external edit: ambiguous text never jumps to an arbitrary occurrence. */
export function reconcileAnchors(strokes: Stroke[], text: string): Stroke[] {
  return strokes.map(stroke => {
    const a = stroke.anchor;
    if (!a) return stroke;
    const s = { ...stroke };
    if (a.orphaned) { s.anchor = { ...a, from: Math.min(a.from, text.length), to: Math.min(a.to, text.length) }; return s; }
    let best = -1, bestScore = -1, tied = false, occurrences = 0;
    if (a.quote) {
      let p = text.indexOf(a.quote);
      while (p >= 0 && occurrences < 10_000) {
        occurrences++;
        const score = contextScore(text, p, a);
        if (score > bestScore) { best = p; bestScore = score; tied = false; }
        else if (score === bestScore) tied = true;
        p = text.indexOf(a.quote, p + 1);
      }
      // A unique substantial quote or a distinguishing context match is strong evidence.
      const safe = best >= 0 && !tied && ((occurrences === 1 && a.quote.length >= 3) || bestScore >= 8 || (best === a.from && text.slice(a.from, a.to) === a.quote));
      if (safe) s.anchor = createAnchor(text, best, best + a.quote.length, a.x, a.y);
      else s.anchor = { ...a, from: Math.min(a.from, text.length), to: Math.min(a.to, text.length), orphaned: true };
    } else {
      const context = a.prefix + a.suffix;
      const match = context.length >= 8 ? text.indexOf(context) : -1;
      if (match >= 0 && text.indexOf(context, match + 1) < 0) {
        const pos = match + a.prefix.length;
        s.anchor = createAnchor(text, pos, pos, a.x, a.y);
      } else if (a.from <= text.length && text.slice(Math.max(0, a.from - a.prefix.length), a.from) === a.prefix && text.slice(a.from, a.from + a.suffix.length) === a.suffix) {
        s.anchor = createAnchor(text, a.from, a.from, a.x, a.y);
      } else s.anchor = { ...a, from: Math.min(a.from, text.length), to: Math.min(a.to, text.length), orphaned: true };
    }
    return s;
  });
}

/** Ink history is independent of the editor's text undo history. */
export class InkModel implements InkSession {
  private state: InkDocument;
  private past: Stroke[][] = [];
  private future: Stroke[][] = [];
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private saving?: Promise<void>;
  private savedRevision: number;
  private hasEverInk: boolean;
  constructor(document: InkDocument, private readonly save: (document: InkDocument) => Promise<void>, private readonly onError: (error: Error) => void = () => {}, private readonly autosaveMs = 550) {
    this.state = cloneDocument(document);
    this.savedRevision = document.revision;
    this.hasEverInk = document.strokes.length > 0;
  }
  get path(): string { return this.state.notePath; }
  get document(): InkDocument { return this.state; }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get dirty(): boolean { return this.state.revision !== this.savedRevision; }
  private changed(): void {
    this.state = { ...this.state, revision: this.state.revision + 1, updatedAt: Date.now() };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}); }, this.autosaveMs);
    for (const listener of this.listeners) listener();
  }
  replace(strokes: Stroke[], _label?: string): void {
    const existing = new Set(this.state.strokes);
    // Prepare a fully valid replacement before touching history, dirty state, or listeners.
    const proposed = validateStrokes(strokes, this.state.sourceText.length, true, existing);
    if (strokes.length) this.hasEverInk = true;
    this.past.push(this.state.strokes);
    if (this.past.length > 100) this.past.shift();
    this.future = [];
    this.state = { ...this.state, strokes: proposed };
    this.changed();
  }
  add(strokes: Stroke[]): void { if (strokes.length) this.replace([...this.state.strokes, ...strokes]); }
  undo(): void {
    const strokes = this.past.pop(); if (!strokes) return;
    this.future.push(this.state.strokes); this.state = { ...this.state, strokes }; this.changed();
  }
  redo(): void {
    const strokes = this.future.pop(); if (!strokes) return;
    this.past.push(this.state.strokes); this.state = { ...this.state, strokes }; this.changed();
  }
  updateText(changes: TextChange[], newText: string): void {
    if (newText === this.state.sourceText) return;
    let previousEnd = 0;
    for (const c of changes) {
      if (!Number.isSafeInteger(c.from) || !Number.isSafeInteger(c.to) || c.from < previousEnd || c.to < c.from || c.to > this.state.sourceText.length || typeof c.insert !== 'string') throw new Error('Inkspace received an invalid text change.');
      previousEnd = c.to;
    }
    // Verify the change set before trusting its positions. External changes use quote reconciliation.
    let expected = '', end = 0;
    for (const c of changes) { expected += this.state.sourceText.slice(end, c.from) + c.insert; end = c.to; }
    expected += this.state.sourceText.slice(end);
    if (expected !== newText) { this.reconcileText(newText); return; }
    const map = this.historyMapper(stroke => mapAnchors([stroke], changes, newText)[0]);
    this.state = { ...this.state, sourceText: newText, strokes: map(this.state.strokes) };
    this.past = this.past.map(map); this.future = this.future.map(map);
    if (this.hasEverInk) this.changed();
  }
  reconcileText(text: string): void {
    if (text === this.state.sourceText) return;
    const map = this.historyMapper(stroke => reconcileAnchors([stroke], text)[0]);
    this.state = { ...this.state, sourceText: text, strokes: map(this.state.strokes) };
    this.past = this.past.map(map); this.future = this.future.map(map);
    if (this.hasEverInk) this.changed();
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private historyMapper(transform: (stroke: Stroke) => Stroke): (strokes: Stroke[]) => Stroke[] {
    const mapped = new Map<Stroke, Stroke>();
    return strokes => strokes.map(stroke => {
      let result = mapped.get(stroke);
      if (!result) { result = transform(stroke); mapped.set(stroke, result); }
      return result;
    });
  }
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.saving) return this.saving;
    if (!this.dirty) return Promise.resolve();
    this.saving = (async () => {
      while (this.dirty) {
        assertDocumentLimits(this.state);
        const snapshot = cloneDocument(this.state);
        await this.save(snapshot);
        this.savedRevision = snapshot.revision;
      }
    })().catch(error => {
      const actual = error instanceof Error ? error : new Error(String(error));
      this.onError(actual);
      throw actual;
    }).finally(() => { this.saving = undefined; });
    return this.saving;
  }
}

const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);
function outline(stroke: Stroke, _settings: Partial<InkSettings> = {}): number[][] {
  // Render flags belong to a stroke: changing the toolbar cannot alter old handwriting.
  return getStroke(stroke.points.map(p => [p.x, p.y, p.pressure]), { size: stroke.width, thinning: stroke.usePressure ? 0.55 : 0, smoothing: stroke.smoothing ?? DEFAULT_SETTINGS.smoothing, streamline: 0.35, simulatePressure: false, last: true });
}
function outlinePath(points: number[][]): string {
  if (!points.length) return '';
  if (points.length < 3) return `M${fmt(points[0][0])} ${fmt(points[0][1])}Z`;
  const first = points[0], second = points[1];
  let path = `M${fmt((first[0] + second[0]) / 2)} ${fmt((first[1] + second[1]) / 2)}`;
  for (let i = 1; i <= points.length; i++) {
    const a = points[i % points.length], b = points[(i + 1) % points.length];
    path += `Q${fmt(a[0])} ${fmt(a[1])} ${fmt((a[0] + b[0]) / 2)} ${fmt((a[1] + b[1]) / 2)}`;
  }
  return path + 'Z';
}
function endPoints(stroke: Stroke): [Point, Point] { const a = stroke.points[0]; return [a, stroke.points[stroke.points.length - 1] ?? a]; }
function arrowWings(stroke: Stroke): [XY, XY] {
  const [a, b] = endPoints(stroke), angle = Math.atan2(b.y - a.y, b.x - a.x), length = Math.min(Math.max(12, stroke.width * 4), Math.hypot(b.x - a.x, b.y - a.y) * 0.5);
  return [-Math.PI / 6, Math.PI / 6].map(offset => ({ x: b.x - length * Math.cos(angle + offset), y: b.y - length * Math.sin(angle + offset) })) as [XY, XY];
}
function centerPath(points: XY[]): string { return points.map((p, i) => `${i ? 'L' : 'M'}${fmt(p.x)} ${fmt(p.y)}`).join(''); }
export function strokePath(stroke: Stroke, settings: Partial<InkSettings> = {}): string {
  if (!stroke.points.length) return '';
  if (stroke.tool === 'pen') return outlinePath(outline(stroke, settings));
  const [a, b] = endPoints(stroke);
  if (stroke.tool === 'rectangle') return `M${fmt(a.x)} ${fmt(a.y)}L${fmt(b.x)} ${fmt(a.y)}L${fmt(b.x)} ${fmt(b.y)}L${fmt(a.x)} ${fmt(b.y)}Z`;
  if (stroke.tool === 'ellipse') {
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
    if (!rx || !ry) return centerPath([a, b]);
    const k = 0.552284749831;
    return `M${fmt(cx + rx)} ${fmt(cy)}C${fmt(cx + rx)} ${fmt(cy + k * ry)} ${fmt(cx + k * rx)} ${fmt(cy + ry)} ${fmt(cx)} ${fmt(cy + ry)}C${fmt(cx - k * rx)} ${fmt(cy + ry)} ${fmt(cx - rx)} ${fmt(cy + k * ry)} ${fmt(cx - rx)} ${fmt(cy)}C${fmt(cx - rx)} ${fmt(cy - k * ry)} ${fmt(cx - k * rx)} ${fmt(cy - ry)} ${fmt(cx)} ${fmt(cy - ry)}C${fmt(cx + k * rx)} ${fmt(cy - ry)} ${fmt(cx + rx)} ${fmt(cy - k * ry)} ${fmt(cx + rx)} ${fmt(cy)}Z`;
  }
  if (stroke.tool === 'arrow') { const [left, right] = arrowWings(stroke); return centerPath([a, b]) + centerPath([left, b, right]); }
  if (stroke.points.length === 1) return centerPath([a, { x: a.x + 0.001, y: a.y }]);
  return centerPath(stroke.tool === 'line' ? [a, b] : stroke.points);
}
const canvasPaths = new WeakMap<Stroke, { signature: string; path: Path2D }>();
function geometrySignature(stroke: Stroke): string {
  const a = stroke.points[0], b = stroke.points[stroke.points.length - 1];
  return `${stroke.tool}/${stroke.width}/${stroke.usePressure}/${stroke.smoothing}/${stroke.points.length}/${a?.x}/${a?.y}/${b?.x}/${b?.y}/${b?.pressure}`;
}
function canvasPath(stroke: Stroke, settings: Partial<InkSettings>): Path2D {
  const signature = geometrySignature(stroke);
  const cached = canvasPaths.get(stroke);
  if (cached?.signature === signature) return cached.path;
  const path = new Path2D(strokePath(stroke, settings));
  canvasPaths.set(stroke, { signature, path });
  return path;
}
/** Same vector geometry powers the editor, SVG exports and PDF exports. */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, dx = 0, dy = 0, settings: Partial<InkSettings> = {}): void {
  if (!stroke.points.length) return;
  ctx.save();
  ctx.translate(dx, dy);
  ctx.globalAlpha = stroke.opacity;
  ctx.fillStyle = stroke.color; ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const path = canvasPath(stroke, settings);
  if (stroke.tool === 'pen') ctx.fill(path); else ctx.stroke(path);
  ctx.restore();
}
const escapeXml = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
export function strokesToSvg(strokes: Stroke[], width: number, height: number, options: { background?: string; offsetX?: number; offsetY?: number } = {}): string {
  width = Number.isFinite(width) ? clamp(width, 1, LIMIT) : 1; height = Number.isFinite(height) ? clamp(height, 1, LIMIT) : 1;
  const dx = Number.isFinite(options.offsetX) ? options.offsetX! : 0, dy = Number.isFinite(options.offsetY) ? options.offsetY! : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" viewBox="0 0 ${fmt(width)} ${fmt(height)}">` +
    (options.background ? `<rect width="100%" height="100%" fill="${escapeXml(options.background)}"/>` : '') +
    `<g transform="translate(${fmt(dx)} ${fmt(dy)})">` + strokes.map(s => `<path d="${strokePath(s)}" ${s.tool === 'pen' ? `fill="${escapeXml(s.color)}"` : `fill="none" stroke="${escapeXml(s.color)}" stroke-width="${fmt(s.width)}" stroke-linecap="round" stroke-linejoin="round"`} opacity="${fmt(s.opacity)}"/>`).join('') + '</g></svg>';
}
const cachedBounds = new WeakMap<Stroke, { signature: string; bounds: Bounds }>();
export function strokeBounds(stroke: Stroke): Bounds {
  const signature = geometrySignature(stroke);
  const cached = cachedBounds.get(stroke);
  if (cached?.signature === signature) return cached.bounds;
  if (!stroke.points.length) return { x: 0, y: 0, width: 0, height: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let points: XY[] = stroke.points;
  if (stroke.tool === 'arrow') points = [...points, ...arrowWings(stroke)];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const margin = stroke.width * (stroke.tool === 'pen' && stroke.usePressure ? 0.8 : 0.5);
  minX -= margin; minY -= margin; maxX += margin; maxY += margin;
  const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY, minX, minY, maxX, maxY };
  cachedBounds.set(stroke, { signature, bounds });
  return bounds;
}
function segmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
  const t = squared ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / squared, 0, 1) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
export function hitStroke(stroke: Stroke, point: XY, radius: number): boolean {
  if (!stroke.points.length) return false;
  const r = Math.max(0, radius) + stroke.width * (stroke.tool === 'pen' && stroke.usePressure ? 0.8 : 0.5), bounds = strokeBounds(stroke);
  if (point.x < bounds.minX - r || point.x > bounds.maxX + r || point.y < bounds.minY - r || point.y > bounds.maxY + r) return false;
  const [a, b] = endPoints(stroke);
  let segments: XY[] = stroke.points;
  if (stroke.tool === 'rectangle') segments = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a];
  else if (stroke.tool === 'ellipse') {
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
    if (rx && ry) segments = Array.from({ length: 65 }, (_, i) => ({ x: cx + rx * Math.cos(i * Math.PI / 32), y: cy + ry * Math.sin(i * Math.PI / 32) }));
    else segments = [a, b];
  } else if (stroke.tool === 'arrow') {
    const [left, right] = arrowWings(stroke);
    return segmentDistance(point, a, b) <= r || segmentDistance(point, left, b) <= r || segmentDistance(point, b, right) <= r;
  } else if (stroke.tool === 'line') segments = [a, b];
  if (segments.length === 1) return Math.hypot(point.x - a.x, point.y - a.y) <= r;
  for (let i = 1; i < segments.length; i++) if (segmentDistance(point, segments[i - 1], segments[i]) <= r) return true;
  return false;
}
export function polygonContains(point: XY, polygon: XY[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if (segmentDistance(point, a, b) < 0.001) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function translateStrokes(strokes: Stroke[], dx: number, dy: number): Stroke[] {
  return strokes.map(stroke => ({ ...cloneStroke(stroke), points: stroke.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })), updatedAt: Date.now() }));
}
export function shapePoints(_tool: Tool, start: Point, end: Point): Point[] { return [{ ...start }, { ...end }]; }
