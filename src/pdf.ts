import { ItemView, loadPdfJs, TFile, type WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import { exportAnnotatedPdf } from './pdf-export';
import { drawStroke, hitStroke } from './core';
import { createStrokeStabilizer } from './stabilizer';
import type { InkHost, InkSession, Point, Stroke } from './types';

export const VIEW_TYPE_PDF = 'inkspace-pdf';
interface PdfPage { getViewport(options: { scale: number }): { width: number; height: number }; render(options: Record<string, unknown>): RenderTask; cleanup(): void }
interface RenderTask { promise: Promise<void>; cancel(): void }
interface PdfDocument { numPages: number; getPage(page: number): Promise<PdfPage>; destroy(): Promise<void> }
interface PdfEngine { getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocument>; destroy(): Promise<void> } }
interface Bounds { x: number; y: number; right: number; bottom: number }
const makeId = (): string => `pdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;

/** Uses Obsidian's own offline PDF.js loader on both iPad and desktop. */
export class InkspacePdfView extends ItemView {
  private path = '';
  private session: InkSession | null = null;
  private pdf: PdfDocument | null = null;
  private renderTask: RenderTask | null = null;
  private pageNumber = 1;
  private zoom = 1;
  private pageWidth = 612;
  private pageHeight = 792;
  private scroll!: HTMLDivElement;
  private paper!: HTMLDivElement;
  private base!: HTMLCanvasElement;
  private ink!: HTMLCanvasElement;
  private navControls!: HTMLDivElement;
  private pageInput!: HTMLInputElement;
  private countLabel!: HTMLSpanElement;
  private message!: HTMLDivElement;
  private sessionOff: (() => void) | null = null;
  private settingsOff: (() => void) | null = null;
  private toolbarOff: (() => void) | null = null;
  private generation = 0;
  private frame = 0;
  private pointerId: number | null = null;
  private activeStroke: Stroke | null = null;
  private stabilizer: ReturnType<typeof createStrokeStabilizer> | null = null;
  private lastSample: Point | null = null;
  private erasedIds: Set<string> | null = null;
  private lasso: Point[] | null = null;
  private selected = new Set<string>();
  private drag: { start: Point; dx: number; dy: number } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private fitting = true;
  private exporting = false;
  private closed = false;
  private cache: HTMLCanvasElement | null = null;
  private cacheDirty = true;

  constructor(leaf: WorkspaceLeaf, private readonly host: InkHost) { super(leaf); }
  getViewType(): string { return VIEW_TYPE_PDF; }
  getDisplayText(): string { return this.path ? this.path.split('/').pop() || 'Inkspace PDF' : 'Inkspace PDF'; }
  getIcon(): string { return 'pen-tool'; }
  getState(): Record<string, unknown> { return { file: this.path, page: this.pageNumber, zoom: this.zoom, fitting: this.fitting }; }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const data = state as { file?: unknown; page?: unknown; zoom?: unknown; fitting?: unknown };
    if (typeof data?.file === 'string' && data.file !== this.path) {
      this.path = data.file;
      this.pageNumber = typeof data.page === 'number' ? Math.max(1, Math.floor(data.page)) : 1;
      this.zoom = typeof data.zoom === 'number' ? Math.max(0.2, Math.min(3, data.zoom)) : 1;
      this.fitting = data.fitting !== false;
      if (this.scroll) await this.loadDocument();
    }
    await super.setState(state, result);
  }
  async onOpen(): Promise<void> {
    this.closed = false;
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (this.path === oldPath || this.path.startsWith(`${oldPath}/`)) {
        this.path = file.path + this.path.slice(oldPath.length);
        this.app.workspace.requestSaveLayout();
      }
    }));
    this.contentEl.empty();
    this.contentEl.addClass('inkspace-pdf-view');
    this.contentEl.style.cssText = 'display:flex;flex-direction:column;overflow:hidden;padding:0;';
    const toolbar = this.contentEl.createDiv('inkspace-pdf-toolbar');
    this.toolbarOff = this.host.toolbar?.(toolbar, () => this.session, { exportPdf: () => { void this.exportPdf(); } }) || null;
    this.navControls = this.contentEl.createDiv('inkspace-pdf-navigation');
    this.navControls.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;';
    this.button(this.navControls, 'Previous page', '‹', () => { void this.goTo(this.pageNumber - 1); });
    this.pageInput = this.navControls.createEl('input', { type: 'number', attr: { min: '1', 'aria-label': 'PDF page number' } });
    this.pageInput.style.width = '58px';
    this.pageInput.addEventListener('change', () => { void this.goTo(Number(this.pageInput.value)); });
    this.countLabel = this.navControls.createEl('span');
    this.button(this.navControls, 'Next page', '›', () => { void this.goTo(this.pageNumber + 1); });
    this.button(this.navControls, 'Zoom out', '−', () => { this.fitting = false; this.zoom = Math.max(0.2, this.zoom / 1.2); void this.renderPage(); });
    this.button(this.navControls, 'Fit page width', 'Fit width', () => { this.fitting = true; this.fit(); void this.renderPage(); });
    this.button(this.navControls, 'Zoom in', '+', () => { this.fitting = false; this.zoom = Math.min(3, this.zoom * 1.2); void this.renderPage(); });
    if (!this.host.toolbar) this.button(this.navControls, 'Export annotated PDF', 'Export PDF', () => { void this.exportPdf(); });
    this.message = this.contentEl.createDiv('inkspace-pdf-message');
    this.message.setAttribute('role', 'status');
    this.scroll = this.contentEl.createDiv('inkspace-pdf-scroll');
    this.scroll.style.cssText = 'position:relative;flex:1;min-height:0;overflow:auto;padding:20px;overscroll-behavior:contain;touch-action:pan-x pan-y pinch-zoom;';
    this.paper = this.scroll.createDiv('inkspace-pdf-page');
    this.paper.style.cssText = 'position:relative;flex:none;background:white;box-shadow:0 4px 22px #0002;margin:0 auto;';
    this.base = this.paper.createEl('canvas', { cls: 'inkspace-pdf-render' });
    this.base.style.cssText = 'display:block;pointer-events:none;width:100%;height:100%;';
    this.ink = this.paper.createEl('canvas', { cls: 'inkspace-pdf-ink', attr: { 'aria-label': 'PDF ink annotation surface', tabindex: '0' } });
    this.ink.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:pan-x pan-y pinch-zoom;';
    this.ink.addEventListener('pointerdown', this.pointerDown);
    this.ink.addEventListener('pointermove', this.pointerMove);
    this.ink.addEventListener('pointerup', this.pointerUp);
    this.ink.addEventListener('pointercancel', this.pointerCancel);
    this.ink.addEventListener('lostpointercapture', this.pointerCancel);
    const guardPencilTouch = (event: TouchEvent): void => {
      const stylus = [...Array.from(event.changedTouches), ...Array.from(event.touches)].some(touch => (touch as Touch & { touchType?: string }).touchType === 'stylus');
      if (this.host.getSettings().enabled && (stylus || this.pointerId !== null) && event.cancelable) event.preventDefault();
    };
    this.ink.addEventListener('touchstart', guardPencilTouch, { passive: false, capture: true });
    this.ink.addEventListener('touchmove', guardPencilTouch, { passive: false, capture: true });
    this.ink.addEventListener('contextmenu', event => { if (this.pointerId !== null) event.preventDefault(); });
    this.ink.addEventListener('keydown', event => {
      if (event.key === 'Escape') { this.cancelInput(); this.selected.clear(); this.schedulePaint(); }
      if ((event.key === 'Delete' || event.key === 'Backspace') && this.selected.size && this.session) {
        event.preventDefault();
        this.session.replace(this.session.document.strokes.filter(stroke => !this.selected.has(stroke.id)), 'Delete selection');
        this.selected.clear();
      }
    });
    this.settingsOff = this.host.subscribeSettings(() => {
      const settings = this.host.getSettings();
      if (!settings.enabled || settings.tool === 'text') this.cancelInput();
      this.cacheDirty = true; this.updateInputMode(); this.schedulePaint();
    });
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.pdf || !this.fitting) return;
      const previous = this.zoom;
      this.fit();
      if (Math.abs(previous - this.zoom) > 0.015) void this.renderPage();
    });
    this.resizeObserver.observe(this.scroll);
    this.updateInputMode();
    if (this.path) await this.loadDocument();
    else this.message.textContent = 'Open a PDF with the Inkspace PDF command.';
  }
  async onClose(): Promise<void> {
    this.closed = true;
    this.generation++;
    this.cancelInput();
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.sessionOff?.(); this.settingsOff?.(); this.toolbarOff?.();
    this.renderTask?.cancel();
    try { await this.session?.flush(); }
    finally { await this.pdf?.destroy(); this.pdf = null; this.cache = null; }
  }
  private button(parent: HTMLElement, label: string, text: string, action: () => void): HTMLButtonElement {
    const button = parent.createEl('button', { text, attr: { 'aria-label': label, title: label } });
    button.addEventListener('click', action);
    return button;
  }
  private async loadDocument(): Promise<void> {
    const generation = ++this.generation;
    this.message.textContent = 'Opening PDF…';
    this.paper.hidden = true;
    this.cancelInput();
    this.sessionOff?.(); this.sessionOff = null;
    this.renderTask?.cancel();
    const previous = this.pdf; this.pdf = null;
    await previous?.destroy();
    try {
      const file = this.app.vault.getAbstractFileByPath(this.path);
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'pdf') throw new Error('The PDF file no longer exists in this vault.');
      const [engine, bytes, session] = await Promise.all([loadPdfJs() as Promise<PdfEngine>, this.app.vault.readBinary(file), this.host.getSession(this.path)]);
      if (this.closed || generation !== this.generation) return;
      const pdf = await engine.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
      if (this.closed || generation !== this.generation) { await pdf.destroy(); return; }
      this.pdf = pdf; this.session = session;
      this.sessionOff = session.subscribe(() => { this.cacheDirty = true; this.schedulePaint(); });
      this.pageNumber = Math.min(pdf.numPages, this.pageNumber);
      this.selected.clear();
      this.message.textContent = 'Draw with Apple Pencil or a stylus. Use a finger to scroll. New ink is editable; original PDF content stays in place.';
      await this.renderPage();
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      this.message.textContent = `Could not open PDF: ${error instanceof Error ? error.message : String(error)}`;
      this.host.status(this.message.textContent, true);
    }
  }
  private fit(): void { this.zoom = Math.max(0.2, Math.min(2, (this.scroll.clientWidth - 40) / this.pageWidth)); }
  private async goTo(page: number): Promise<void> {
    if (!this.pdf || !Number.isFinite(page)) return;
    this.cancelInput();
    this.pageNumber = Math.max(1, Math.min(this.pdf.numPages, Math.floor(page)));
    this.selected.clear();
    this.scroll.scrollTop = 0;
    await this.renderPage();
  }
  private async renderPage(): Promise<void> {
    if (!this.pdf || this.closed) return;
    this.cancelInput();
    const generation = ++this.generation;
    const previousTask = this.renderTask;
    previousTask?.cancel();
    try {
      if (previousTask) await previousTask.promise.catch(() => {});
      if (generation !== this.generation || this.closed) return;
      const page = await this.pdf.getPage(this.pageNumber);
      if (generation !== this.generation || this.closed) return;
      const viewport = page.getViewport({ scale: 1 });
      this.pageWidth = viewport.width; this.pageHeight = viewport.height;
      if (this.fitting) this.fit();
      const cssWidth = this.pageWidth * this.zoom, cssHeight = this.pageHeight * this.zoom;
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (cssWidth * cssHeight)));
      this.paper.style.width = `${cssWidth}px`; this.paper.style.height = `${cssHeight}px`;
      this.base.width = Math.ceil(cssWidth * ratio); this.base.height = Math.ceil(cssHeight * ratio);
      this.ink.width = this.base.width; this.ink.height = this.base.height;
      this.cacheDirty = true;
      const context = this.base.getContext('2d', { alpha: false });
      if (!context) throw new Error('Canvas is unavailable.');
      const task = page.render({ canvasContext: context, viewport: page.getViewport({ scale: this.zoom * ratio }), background: 'rgb(255,255,255)' });
      this.renderTask = task;
      await task.promise;
      if (generation !== this.generation || this.closed) return;
      page.cleanup();
      this.renderTask = null;
      this.pageInput.value = String(this.pageNumber);
      this.pageInput.max = String(this.pdf.numPages);
      this.countLabel.textContent = `/ ${this.pdf.numPages} · ${Math.round(this.zoom * 100)}%`;
      this.paper.hidden = false;
      this.schedulePaint();
    } catch (error) {
      if (generation !== this.generation || this.closed || (error instanceof Error && error.name === 'RenderingCancelledException')) return;
      this.message.textContent = `Could not render this page: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  private updateInputMode(): void {
    if (!this.ink) return;
    const settings = this.host.getSettings();
    this.ink.style.pointerEvents = settings.enabled ? 'auto' : 'none';
    this.ink.style.cursor = settings.mouseDrawing ? settings.tool === 'lasso' ? 'crosshair' : 'crosshair' : 'default';
  }
  private point(event: PointerEvent): Point {
    const rect = this.ink.getBoundingClientRect();
    // Lift events commonly report zero pressure rather than a new contact
    // measurement. Retain the last contact's pressure instead of thickening its tail.
    const pressure = event.pressure > 0 ? event.pressure : this.lastSample?.pressure ?? 0.5;
    return { x: (event.clientX - rect.left) * this.pageWidth / rect.width, y: (event.clientY - rect.top) * this.pageHeight / rect.height, pressure, t: event.timeStamp };
  }
  private pointerDown = (event: PointerEvent): void => {
    const settings = this.host.getSettings();
    if (!this.pdf || !this.session || !settings.enabled || this.pointerId !== null || event.pointerType === 'touch' || (event.pointerType === 'mouse' && (!settings.mouseDrawing || event.button !== 0))) return;
    if (settings.tool === 'text') { this.host.status('Type in Markdown notes. On a PDF, choose a pen, highlighter, shape, eraser, or lasso.'); return; }
    const point = this.point(event);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    event.preventDefault();
    this.pointerId = event.pointerId;
    try { this.ink.setPointerCapture(event.pointerId); }
    catch { this.cancelInput(); return; }
    this.ink.focus({ preventScroll: true });
    this.lastSample = point;
    if (settings.tool === 'eraser' || event.button === 5 || event.buttons === 32) {
      this.erasedIds = new Set(); this.eraseAt(point);
    } else if (settings.tool === 'lasso') {
      const bounds = this.selectionBounds();
      if (bounds && point.x >= bounds.x - 8 && point.x <= bounds.right + 8 && point.y >= bounds.y - 8 && point.y <= bounds.bottom + 8) { this.drag = { start: point, dx: 0, dy: 0 }; this.cacheDirty = true; }
      else { this.selected.clear(); this.lasso = [point]; }
    } else {
      this.selected.clear();
      this.stabilizer = settings.tool === 'pen' || settings.tool === 'highlighter' ? createStrokeStabilizer(settings.stabilization) : null;
      this.activeStroke = { id: makeId(), tool: settings.tool, points: [this.stabilizer?.next(point) ?? point], color: settings.color, width: settings.tool === 'highlighter' ? settings.highlighterWidth : settings.penWidth, opacity: settings.tool === 'highlighter' ? settings.highlighterOpacity : 1, page: this.pageNumber, smoothing: settings.smoothing, usePressure: settings.usePressure, updatedAt: Date.now() };
    }
    this.schedulePaint();
  };
  private pointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    event.preventDefault();
    const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
    // A WebView may omit the dispatch event from its historical samples. Always
    // include it so a short final movement on pointerup is not lost.
    for (const sample of samples.includes(event) ? samples : [...samples, event]) {
      let point = this.point(sample);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      const previousSample = this.lastSample;
      if (previousSample && point.x === previousSample.x && point.y === previousSample.y && point.t === previousSample.t) continue;
      this.lastSample = point;
      if (this.activeStroke) {
        if (this.activeStroke.tool === 'pen' || this.activeStroke.tool === 'highlighter') {
          point = this.stabilizer?.next(point) ?? point;
          const previous = this.activeStroke.points[this.activeStroke.points.length - 1];
          if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.15) this.activeStroke.points.push(point);
        }
        else this.activeStroke.points = [this.activeStroke.points[0], point];
      }
      else if (this.erasedIds) this.eraseAt(point);
      else if (this.lasso) this.lasso.push(point);
      else if (this.drag) { this.drag.dx = point.x - this.drag.start.x; this.drag.dy = point.y - this.drag.start.y; }
    }
    this.schedulePaint();
  };
  private pointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId || !this.session) return;
    try {
      this.pointerMove(event);
      if (this.activeStroke) this.session.add([this.activeStroke]);
      if (this.erasedIds?.size) this.session.replace(this.session.document.strokes.filter(stroke => !this.erasedIds!.has(stroke.id)), 'Erase PDF ink');
      if (this.lasso && this.lasso.length > 2) {
        const polygon = this.lasso;
        this.selected = new Set(this.pageStrokes().filter(stroke => stroke.points.some(point => insidePolygon(point, polygon))).map(stroke => stroke.id));
      }
      if (this.drag && (this.drag.dx || this.drag.dy)) {
        const drag = this.drag;
        this.session.replace(this.session.document.strokes.map(stroke => this.selected.has(stroke.id) ? { ...stroke, updatedAt: Date.now(), points: stroke.points.map(point => ({ ...point, x: point.x + drag.dx, y: point.y + drag.dy })) } : stroke), 'Move PDF ink');
      }
    } catch (error) { this.host.status(error instanceof Error ? error.message : String(error),true); }
    finally { this.cancelInput(); this.schedulePaint(); }
  };
  private pointerCancel = (event: PointerEvent): void => { if (event.pointerId === this.pointerId) { this.cancelInput(); this.schedulePaint(); } };
  private cancelInput(): void {
    const pointer = this.pointerId;
    this.pointerId = null; this.activeStroke = null; this.stabilizer = null; this.lastSample = null; this.erasedIds = null; this.lasso = null; this.drag = null;
    this.cacheDirty = true;
    if (pointer !== null && this.ink?.hasPointerCapture(pointer)) this.ink.releasePointerCapture(pointer);
  }
  private pageStrokes(): Stroke[] { return (this.session?.document.strokes || []).filter(stroke => (stroke.page || 1) === this.pageNumber && !this.erasedIds?.has(stroke.id)); }
  private eraseAt(point: Point): void {
    if (!this.erasedIds) return;
    const radius = this.host.getSettings().eraserSize / this.zoom;
    const previous = this.erasedIds.size;
    for(const stroke of this.session?.document.strokes || []) if((stroke.page || 1)===this.pageNumber && !this.erasedIds.has(stroke.id) && hitStroke(stroke,point,radius)) this.erasedIds.add(stroke.id);
    if (this.erasedIds.size !== previous) this.cacheDirty = true;
  }
  private selectionBounds(): Bounds | null {
    let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
    for (const stroke of this.pageStrokes()) if (this.selected.has(stroke.id)) for (const point of stroke.points) {
      x = Math.min(x, point.x); y = Math.min(y, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y);
    }
    return x === Infinity ? null : { x, y, right, bottom };
  }
  private schedulePaint(): void {
    if (!this.frame && !this.closed) this.frame = requestAnimationFrame(() => { this.frame = 0; this.paint(); });
  }
  private paint(): void {
    const context = this.ink?.getContext('2d');
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, this.ink.width, this.ink.height);
    const settings = this.host.getSettings();
    if (!this.cache) this.cache = document.createElement('canvas');
    if (this.cache.width !== this.ink.width || this.cache.height !== this.ink.height) { this.cache.width = this.ink.width; this.cache.height = this.ink.height; this.cacheDirty = true; }
    if (this.cacheDirty) {
      const cached = this.cache.getContext('2d');
      if (cached) {
        cached.setTransform(1, 0, 0, 1, 0, 0); cached.clearRect(0, 0, this.cache.width, this.cache.height);
        cached.setTransform(this.ink.width / this.pageWidth, 0, 0, this.ink.height / this.pageHeight, 0, 0);
        for (const stroke of this.pageStrokes()) if (!this.drag || !this.selected.has(stroke.id)) drawStroke(cached, stroke, 0, 0, settings);
      }
      this.cacheDirty = false;
    }
    context.drawImage(this.cache, 0, 0);
    context.setTransform(this.ink.width / this.pageWidth, 0, 0, this.ink.height / this.pageHeight, 0, 0);
    if (this.drag) for (const stroke of this.pageStrokes()) if (this.selected.has(stroke.id)) drawStroke(context, stroke, this.drag.dx, this.drag.dy, settings);
    if (this.activeStroke) drawStroke(context, this.activeStroke, 0, 0, settings);
    context.strokeStyle = '#2563eb'; context.lineWidth = 1.5 / this.zoom; context.setLineDash([5 / this.zoom, 4 / this.zoom]);
    if (this.lasso?.length) {
      context.beginPath(); context.moveTo(this.lasso[0].x, this.lasso[0].y);
      for (const point of this.lasso.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    }
    const bounds = this.selectionBounds();
    if (bounds) context.strokeRect(bounds.x - 5 + (this.drag?.dx || 0), bounds.y - 5 + (this.drag?.dy || 0), bounds.right - bounds.x + 10, bounds.bottom - bounds.y + 10);
    context.setLineDash([]);
  }
  async exportPdf(): Promise<void> {
    if (!this.session || this.exporting) return;
    this.exporting = true;
    try {
      this.host.status('Preparing annotated PDF…');
      await this.session.flush();
      const file = this.app.vault.getAbstractFileByPath(this.path);
      if (!(file instanceof TFile)) throw new Error('Original PDF no longer exists.');
      const bytes = await exportAnnotatedPdf(await this.app.vault.readBinary(file), this.session.document.strokes);
      const stem = this.path.replace(/\.pdf$/i, '');
      let target = `${stem} - annotated.pdf`;
      for (let index = 2; await this.app.vault.adapter.exists(target); index++) target = `${stem} - annotated (${index}).pdf`;
      const created = await this.app.vault.createBinary(target, bytes.slice().buffer as ArrayBuffer);
      this.host.status(`Annotated copy saved: ${target}`);
      await this.app.workspace.getLeaf('tab').openFile(created);
    } catch (error) { this.host.status(`PDF export failed: ${error instanceof Error ? error.message : String(error)}`, true); }
    finally { this.exporting = false; }
  }
}

function insidePolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}



