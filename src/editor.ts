import { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { createAnchor, createId, drawStroke, hitStroke, polygonContains, shapePoints, strokeBounds, strokesToSvg, translateStrokes } from './core';
import type { Anchor, InkHost, InkSession, Point, Stroke, StrokeTool, Tool } from './types';
import { createStrokeStabilizer } from './stabilizer';

// Ink coordinates are unzoomed contentDOM coordinates. Canvas dimensions and client coordinates
// are screen pixels; convert only at the input/render boundary so saved vectors never shrink.
type Geometry = { left: number; top: number; width: number; height: number; scrollX: number; scrollY: number; canvasLeft: number; canvasTop: number; dpr: number; scale: number };
type Placement = { dx: number; dy: number };
type Gesture = { pointerId: number; kind: 'draw' | 'erase' | 'lasso' | 'move'; tool: Tool; points: Point[]; stroke?: Stroke; stabilizer?: ReturnType<typeof createStrokeStabilizer>; lastInput: Point; erased: Set<string>; origin: Point; delta: { x: number; y: number }; geometry: Geometry; session: InkSession };
type ZoomFocal = { x: number; y: number; screenX: number; screenY: number };
type Pinch = { distance: number; zoom: number; x: number; y: number };
const SHAPES = new Set<Tool>(['line', 'arrow', 'rectangle', 'ellipse']);
const editors = new WeakMap<InkHost, Set<InkEditor>>();

/** Ink is painted above the *existing* CodeMirror editor. No replacement editor or embedded writing box. */
class InkEditor {
  private readonly overlay: HTMLDivElement;
  private readonly savedCanvas: HTMLCanvasElement;
  private readonly liveCanvas: HTMLCanvasElement;
  private readonly toolbarHost: HTMLDivElement;
  private readonly selectionTools: HTMLDivElement;
  private readonly orphanStatus: HTMLDivElement;
  private readonly mouseButton: HTMLButtonElement;
  private readonly win: Window & typeof globalThis;
  private readonly doc: Document;
  private toolbarCleanup?: () => void;
  private settingsCleanup: () => void;
  private sessionCleanup?: () => void;
  private resizeObserver?: ResizeObserver;
  private session: InkSession | null = null;
  private requestedPath: string | null = null;
  private generation = 0;
  private destroyed = false;
  private frame = 0;
  private savedDirty = true;
  private liveDirty = true;
  private geometry: Geometry | null = null;
  private placements = new Map<string, Placement>();
  private selected = new Set<string>();
  private readonly rejectedStrokes = new Map<string, Stroke[]>();
  private gesture: Gesture | null = null;
  private originalPosition = '';
  private readonly originalZoom: string;
  private readonly originalZoomScale: number;
  private readonly zoomAvailable: boolean;
  private readonly zoomMode: 'css' | 'transform';
  private readonly originalTransform: string;
  private readonly originalTransformOrigin: string;
  private readonly originalMarginLeft: string;
  private readonly originalMarginRight: string;
  private appliedZoom = 1;
  private warnedZoom = false;
  private pendingZoom: ZoomFocal | null = null;
  private pinch: Pinch | null = null;

  constructor(private readonly view: EditorView, private readonly host: InkHost) {
    this.doc = view.dom.ownerDocument;
    this.win = this.doc.defaultView ?? window;
    this.originalZoom = view.contentDOM.style.getPropertyValue('zoom');
    this.originalTransform = view.contentDOM.style.transform;
    this.originalTransformOrigin = view.contentDOM.style.transformOrigin;
    this.originalMarginLeft = view.contentDOM.style.marginLeft;
    this.originalMarginRight = view.contentDOM.style.marginRight;
    const originalScale = this.win.getComputedStyle(view.contentDOM).getPropertyValue('zoom');
    const parsedScale = parseFloat(originalScale) / (originalScale.trim().endsWith('%') ? 100 : 1);
    this.originalZoomScale = Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : 1;
    this.appliedZoom = this.originalZoomScale;
    this.zoomAvailable = true; // CSS transforms are supported by every Obsidian mobile WebView.
    // Some WebKit builds paint CSS zoom but return *unzoomed* client/range rectangles.
    // CodeMirror needs truthful rectangles for caret placement, so test geometry, not CSS.supports.
    const probe = this.doc.createElement('div');
    probe.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:100px;height:10px;visibility:hidden;pointer-events:none;zoom:1';
    this.doc.body.append(probe);
    const baseWidth = probe.getBoundingClientRect().width;
    probe.style.setProperty('zoom', '.5');
    const scaledWidth = probe.getBoundingClientRect().width;
    this.zoomMode = baseWidth > 0 && Math.abs(scaledWidth / baseWidth - .5) < .02 ? 'css' : 'transform';
    probe.remove();
    this.originalPosition = view.dom.style.position;
    if (this.win.getComputedStyle(view.dom).position === 'static') view.dom.style.position = 'relative';
    view.dom.classList.add('inkspace-editor');

    this.overlay = this.doc.createElement('div');
    this.overlay.className = 'inkspace-overlay';
    Object.assign(this.overlay.style, { position: 'absolute', pointerEvents: 'none', overflow: 'hidden', zIndex: '6' });
    this.overlay.setAttribute('aria-hidden', 'true');
    this.savedCanvas = this.makeCanvas('inkspace-saved-ink');
    this.liveCanvas = this.makeCanvas('inkspace-live-ink');
    this.overlay.append(this.savedCanvas, this.liveCanvas);
    view.dom.append(this.overlay);

    this.toolbarHost = this.doc.createElement('div');
    this.toolbarHost.className = 'inkspace-toolbar-host';
    Object.assign(this.toolbarHost.style, { position: 'absolute', top: '8px', right: '12px', zIndex: '12', pointerEvents: 'auto' });
    view.dom.append(this.toolbarHost);
    this.toolbarCleanup = host.toolbar?.(this.toolbarHost, () => this.session, {
      exportSvg: () => this.downloadSvg(),
      insertSpace: () => {
        const line = this.view.state.doc.lineAt(this.view.state.selection.main.head);
        this.view.dispatch({
          changes: { from: line.to, insert: '\n'.repeat(8) },
          selection: { anchor: line.to + 1 },
          scrollIntoView: true,
        });
      },
    });

    this.selectionTools = this.doc.createElement('div');
    this.selectionTools.className = 'inkspace-selection-tools';
    Object.assign(this.selectionTools.style, { position: 'absolute', right: '12px', bottom: '12px', zIndex: '13', display: 'flex', gap: '4px', alignItems: 'center', pointerEvents: 'auto' });
    const hint = this.doc.createElement('span');
    hint.className = 'inkspace-selection-hint';
    hint.textContent = 'Drag selection to move';
    this.selectionTools.append(hint);
    this.action('Copy', () => this.copySelection());
    this.action('Delete', () => this.deleteSelection());
    this.action('Clear selection', () => { this.selected.clear(); this.updateSelectionUi(); this.invalidate(false); });
    this.mouseButton = this.action('Mouse ink: off', () => this.host.updateSettings({ mouseDrawing: !this.host.getSettings().mouseDrawing }));
    this.mouseButton.classList.add('inkspace-mouse-mode');
    view.dom.append(this.selectionTools);

    this.orphanStatus = this.doc.createElement('div');
    this.orphanStatus.className = 'inkspace-orphan-status';
    Object.assign(this.orphanStatus.style, { position: 'absolute', left: '12px', bottom: '12px', zIndex: '11', pointerEvents: 'none' });
    this.orphanStatus.title = 'The attached text changed. The ink has been preserved. Use Lasso to move it onto the intended text and attach it again.';
    view.dom.append(this.orphanStatus);

    view.dom.addEventListener('pointerdown', this.onPointerDown, true);
    this.doc.addEventListener('pointermove', this.onPointerMove, { capture: true, passive: false });
    this.doc.addEventListener('pointerup', this.onPointerUp, { capture: true, passive: false });
    this.doc.addEventListener('pointercancel', this.onPointerCancel, true);
    view.dom.addEventListener('lostpointercapture', this.onLostCapture, true);
    // iPadOS also emits stylus TouchEvents. Cancel those only, leaving finger scrolling native.
    view.dom.addEventListener('touchstart', this.onTouch, { capture: true, passive: false });
    view.dom.addEventListener('touchmove', this.onTouch, { capture: true, passive: false });
    view.dom.addEventListener('touchend', this.onTouchEnd, true);
    view.dom.addEventListener('touchcancel', this.onTouchEnd, true);
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    view.dom.addEventListener('keydown', this.onKeyDown, true);
    this.win.addEventListener('resize', this.onResize);
    this.win.visualViewport?.addEventListener('resize', this.onResize);
    this.win.visualViewport?.addEventListener('scroll', this.onResize);
    const Resize = this.win.ResizeObserver;
    if (Resize) {
      const observer = new Resize(this.onResize);
      this.resizeObserver = observer;
      observer.observe(view.dom);
      observer.observe(view.scrollDOM);
      observer.observe(view.contentDOM);
      observer.observe(this.toolbarHost);
    }
    this.settingsCleanup = host.subscribeSettings(() => {
      this.bindSession();
      if (!this.host.getSettings().enabled || this.host.getSettings().tool === 'text') this.cancelGesture();
      this.applySettings();
      this.measure();
    });
    this.applySettings();
    const registered = editors.get(host) ?? new Set<InkEditor>();
    registered.add(this);
    editors.set(host, registered);
    this.bindSession();
    this.measure();
  }

  private makeCanvas(className: string): HTMLCanvasElement {
    const canvas = this.doc.createElement('canvas');
    canvas.className = className;
    Object.assign(canvas.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    return canvas;
  }

  private action(label: string, callback: () => void): HTMLButtonElement {
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', callback);
    this.selectionTools.append(button);
    return button;
  }

  update(update: ViewUpdate): void {
    this.bindSession();
    if (update.docChanged && this.session) {
      const before = update.startState.doc.toString();
      const after = update.state.doc.toString();
      if (this.session.document.sourceText === before) {
        const changes: { from: number; to: number; insert: string }[] = [];
        update.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => changes.push({ from, to, insert: inserted.toString() }));
        this.mutate(() => this.session!.updateText(changes, after), 'Ink alignment could not be updated');
      } else if (this.session.document.sourceText !== after) {
        // Two editor panes may receive the same note change. Never map its anchors twice.
        this.mutate(() => this.session!.reconcileText(after), 'Ink alignment could not be updated');
      }
    }
    if (update.docChanged || update.geometryChanged || update.viewportChanged) this.measure();
  }

  docViewUpdate(): void { this.measure(); }

  private bindSession(): void {
    const resolved = this.host.resolveEditor(this.view);
    const path = resolved?.path ?? null;
    if (path === this.requestedPath) return;
    this.requestedPath = path;
    const generation = ++this.generation;
    this.cancelGesture();
    this.sessionCleanup?.();
    this.sessionCleanup = undefined;
    this.session = null;
    this.selected.clear();
    this.placements.clear();
    this.updateSelectionUi();
    this.invalidate();
    if (!path) return;
    void this.host.getSession(path).then(session => {
      if (this.destroyed || generation !== this.generation || path !== this.requestedPath) return;
      this.session = session;
      const text = this.view.state.doc.toString();
      if (session.document.sourceText !== text) this.mutate(() => session.reconcileText(text), 'Ink alignment could not be updated');
      this.sessionCleanup = session.subscribe(() => {
        if (session !== this.session) return;
        const ids = new Set(session.document.strokes.map(stroke => stroke.id));
        this.selected.forEach(id => { if (!ids.has(id)) this.selected.delete(id); });
        this.updateSelectionUi();
        this.measure();
      });
      this.updateSelectionUi();
      this.measure();
    }).catch(error => {
      if (!this.destroyed && generation === this.generation) {
        this.requestedPath = null; // A later interaction can retry a transient read failure.
        this.host.status(`Could not load ink for this note: ${String(error)}`, true);
      }
    });
  }

  private applySettings(): void {
    const settings = this.host.getSettings();
    const nextZoom = settings.enabled && this.zoomAvailable ? Math.max(0.4, Math.min(2, settings.zoom)) : this.originalZoomScale;
    if (nextZoom !== this.appliedZoom) {
      if (!this.pendingZoom) {
        const before = this.readGeometry();
        this.pendingZoom = { x: before.scrollX + before.width / 2, y: before.scrollY + before.height / 2, screenX: before.width * before.scale / 2, screenY: before.height * before.scale / 2 };
      }
      this.cancelGesture();
      this.appliedZoom = nextZoom;
    }
    if (settings.enabled && this.zoomMode === 'css') this.view.contentDOM.style.setProperty('zoom', String(nextZoom));
    else if (settings.enabled) {
      this.view.contentDOM.style.setProperty('zoom', '1');
      this.view.contentDOM.style.transform = `scale(${nextZoom})${this.originalTransform ? ` ${this.originalTransform}` : ''}`;
      this.view.contentDOM.style.transformOrigin = '0 0';
      this.applyTransformMargins(this.view.contentDOM.offsetWidth || settings.writingWidth);
    } else {
      if (this.originalZoom) this.view.contentDOM.style.setProperty('zoom', this.originalZoom); else this.view.contentDOM.style.removeProperty('zoom');
      this.restoreTransform();
    }
    this.view.dom.dataset.inkspaceZoomMode = this.zoomMode;
    if (!settings.enabled) this.pinch = null;
    if (!this.zoomAvailable && settings.zoom !== 1 && !this.warnedZoom) {
      this.warnedZoom = true;
      this.host.status('This WebView does not support document zoom. Update Obsidian/iPadOS to use the zoom controls.', true);
    }
    this.view.dom.classList.toggle('inkspace-stable-layout', settings.stableLayout);
    this.view.dom.classList.toggle('inkspace-enabled', settings.enabled);
    this.view.dom.dataset.inkspacePaper = settings.paper;
    for (const paper of ['ruled', 'grid', 'dots']) this.view.dom.classList.toggle(`inkspace-paper-${paper}`, settings.paper === paper);
    this.view.dom.style.setProperty('--inkspace-writing-width', `${settings.writingWidth}px`);
    this.overlay.style.display = settings.enabled ? '' : 'none';
    this.toolbarHost.style.display = settings.enabled ? '' : 'none';
    this.mouseButton.textContent = `Mouse ink: ${settings.mouseDrawing ? 'on' : 'off'}`;
    this.mouseButton.setAttribute('aria-pressed', String(settings.mouseDrawing));
    this.updateSelectionUi();
    this.invalidate();
  }

  private updateSelectionUi(): void {
    if (!this.selectionTools) return;
    const settings = this.host.getSettings();
    this.selectionTools.style.display = settings.enabled && settings.tool === 'lasso' ? 'flex' : 'none';
    this.selectionTools.querySelectorAll<HTMLButtonElement>('button:not(.inkspace-mouse-mode)').forEach(button => { button.disabled = this.selected.size === 0; });
    const hint = this.selectionTools.querySelector('.inkspace-selection-hint');
    if (hint) hint.textContent = this.selected.size ? `${this.selected.size} selected · drag to move` : 'Draw around ink to select';
    const orphaned = this.session?.document.strokes.filter(stroke => stroke.anchor?.orphaned).length ?? 0;
    const rejected = this.session ? this.rejectedStrokes.get(this.session.path)?.length ?? 0 : 0;
    if (this.orphanStatus) {
      this.orphanStatus.textContent = rejected ? `${rejected} unsaved ${rejected === 1 ? 'mark' : 'marks'} · export SVG before closing` : orphaned ? `${orphaned} ${orphaned === 1 ? 'mark needs' : 'marks need'} alignment` : '';
      this.orphanStatus.title = rejected ? 'These marks exceeded a save limit. They remain in this editor and its SVG export, but are not saved in your vault. Export ink as SVG before closing this editor.' : 'The attached text changed. The ink has been preserved. Use Lasso to move it onto the intended text and attach it again.';
      this.orphanStatus.style.display = (orphaned || rejected) && settings.enabled ? '' : 'none';
    }
  }

  private visibleStrokes(): Stroke[] {
    return this.session ? [...this.session.document.strokes, ...(this.rejectedStrokes.get(this.session.path) ?? [])] : [];
  }

  private mutate(action: () => void, message: string, rejected?: Stroke[]): boolean {
    try { action(); return true; }
    catch (error) {
      if (rejected?.length && this.session) {
        const existing = this.rejectedStrokes.get(this.session.path) ?? [];
        this.rejectedStrokes.set(this.session.path, [...existing, ...rejected]);
      }
      const recovery = rejected?.length ? ' The new ink remains in this editor and SVG export. Export ink as SVG before closing this editor.' : ' Your saved ink was kept unchanged.';
      this.host.status(`${message}: ${String(error)}.${recovery}`, true);
      this.updateSelectionUi();
      this.measure();
      return false;
    }
  }

  private readGeometry(): Geometry {
    const rect = this.view.scrollDOM.getBoundingClientRect();
    const content = this.view.contentDOM.getBoundingClientRect();
    const outer = this.view.dom.getBoundingClientRect();
    const scale = this.appliedZoom;
    return { left: rect.left, top: rect.top, width: this.view.scrollDOM.clientWidth / scale, height: this.view.scrollDOM.clientHeight / scale, scrollX: (rect.left - content.left) / scale, scrollY: (rect.top - content.top) / scale, canvasLeft: rect.left - outer.left, canvasTop: rect.top - outer.top, dpr: this.win.devicePixelRatio || 1, scale };
  }

  private applyTransformMargins(width: number): void {
    if (this.zoomMode !== 'transform' || !this.host.getSettings().enabled) return;
    const scaledWidth = width * this.appliedZoom;
    // Keep the visual page centered. A negative trailing margin compensates its unscaled flex box.
    this.view.contentDOM.style.marginLeft = `max(0px, calc((100% - ${scaledWidth}px) / 2))`;
    this.view.contentDOM.style.marginRight = `${width * (this.appliedZoom - 1)}px`;
  }

  private restoreTransform(): void {
    this.view.contentDOM.style.transform = this.originalTransform;
    this.view.contentDOM.style.transformOrigin = this.originalTransformOrigin;
    this.view.contentDOM.style.marginLeft = this.originalMarginLeft;
    this.view.contentDOM.style.marginRight = this.originalMarginRight;
  }

  private measure(): void {
    if (this.destroyed) return;
    this.view.requestMeasure({
      key: this,
      read: () => {
        const geometry = this.readGeometry();
        const placements = new Map<string, Placement>();
        const positions = new Map<number, { x: number; y: number }>();
        const contentRect = this.view.contentDOM.getBoundingClientRect();
        const padding = parseFloat(this.win.getComputedStyle(this.view.contentDOM).paddingLeft) || 0;
        for (const stroke of this.visibleStrokes()) {
          const anchor = stroke.anchor;
          if (!anchor || anchor.orphaned || anchor.from < 0 || anchor.from > this.view.state.doc.length) {
            placements.set(stroke.id, { dx: 0, dy: 0 });
            continue;
          }
          let position = positions.get(anchor.from);
          if (!position) {
            const coords = this.view.coordsAtPos(anchor.from);
            // Offscreen lines use CM's block geometry and the last measured horizontal offset.
            // Only exact DOM character coordinates are used for visible text.
            const word = this.view.state.doc.lineAt(anchor.from).from !== anchor.from;
            const previous = this.placements.get(stroke.id);
            const x = coords ? (coords.left - geometry.left) / geometry.scale + geometry.scrollX : word ? anchor.x + (previous?.dx ?? 0) : padding;
            const y = coords ? (coords.top - geometry.top) / geometry.scale + geometry.scrollY : (this.view.documentTop - contentRect.top + this.view.lineBlockAt(anchor.from).top) / geometry.scale;
            position = { x, y };
            positions.set(anchor.from, position);
          }
          const { x, y } = position;
          placements.set(stroke.id, { dx: x - anchor.x, dy: y - anchor.y });
        }
        return { geometry, placements, contentWidth: this.view.contentDOM.offsetWidth, toolbarHeight: Math.ceil(this.toolbarHost.getBoundingClientRect().height) };
      },
      write: ({ geometry, placements, contentWidth, toolbarHeight }) => {
        if (this.destroyed) return;
        this.applyTransformMargins(contentWidth);
        const toolbarCss = `${toolbarHeight}px`;
        if (this.view.dom.style.getPropertyValue('--inkspace-toolbar-height') !== toolbarCss) {
          this.view.dom.style.setProperty('--inkspace-toolbar-height', toolbarCss);
          this.measure();
        }
        if (this.pendingZoom) {
          const focal = this.pendingZoom;
          this.pendingZoom = null;
          this.view.scrollDOM.scrollLeft += (focal.x - geometry.scrollX) * geometry.scale - focal.screenX;
          this.view.scrollDOM.scrollTop += (focal.y - geometry.scrollY) * geometry.scale - focal.screenY;
          this.measure();
          return;
        }
        this.geometry = geometry;
        this.placements = placements;
        Object.assign(this.overlay.style, { left: `${geometry.canvasLeft}px`, top: `${geometry.canvasTop}px`, width: `${geometry.width * geometry.scale}px`, height: `${geometry.height * geometry.scale}px` });
        for (const canvas of [this.savedCanvas, this.liveCanvas]) {
          const width = Math.max(1, Math.round(geometry.width * geometry.scale * geometry.dpr));
          const height = Math.max(1, Math.round(geometry.height * geometry.scale * geometry.dpr));
          if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
          canvas.style.width = `${geometry.width * geometry.scale}px`;
          canvas.style.height = `${geometry.height * geometry.scale}px`;
        }
        this.updateSelectionUi();
        this.invalidate();
      },
    });
  }

  private invalidate(saved = true): void {
    this.savedDirty ||= saved;
    this.liveDirty = true;
    if (this.frame || this.destroyed) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = 0;
      if (this.savedDirty) { this.savedDirty = false; this.renderSaved(); }
      if (this.liveDirty) { this.liveDirty = false; this.renderLive(); }
    });
  }

  private context(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const geometry = this.geometry;
    const ctx = canvas.getContext('2d');
    if (!geometry || !ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = geometry.dpr * geometry.scale;
    ctx.setTransform(scale, 0, 0, scale, -geometry.scrollX * scale, -geometry.scrollY * scale);
    return ctx;
  }

  private placement(stroke: Stroke): Placement { return this.placements.get(stroke.id) ?? { dx: 0, dy: 0 }; }

  private renderSaved(): void {
    const ctx = this.context(this.savedCanvas);
    const geometry = this.geometry;
    if (!ctx || !geometry || !this.host.getSettings().enabled) return;
    for (const stroke of this.visibleStrokes()) {
      if (this.gesture?.erased.has(stroke.id)) continue;
      if (this.gesture?.kind === 'move' && this.selected.has(stroke.id)) continue;
      const shift = this.placement(stroke);
      const bounds = strokeBounds(stroke);
      if (bounds.maxX + shift.dx < geometry.scrollX || bounds.minX + shift.dx > geometry.scrollX + geometry.width || bounds.maxY + shift.dy < geometry.scrollY || bounds.minY + shift.dy > geometry.scrollY + geometry.height) continue;
      drawStroke(ctx, stroke, shift.dx, shift.dy, this.host.getSettings());
      if (stroke.anchor?.orphaned) {
        ctx.save(); ctx.strokeStyle = '#e59a32'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        ctx.strokeRect(bounds.minX - 3, bounds.minY - 3, Math.max(6, bounds.width + 6), Math.max(6, bounds.height + 6)); ctx.restore();
      }
    }
  }

  private renderLive(): void {
    const ctx = this.context(this.liveCanvas);
    if (!ctx || !this.host.getSettings().enabled) return;
    const gesture = this.gesture;
    if (gesture?.kind === 'draw' && gesture.stroke) drawStroke(ctx, this.previewStroke(gesture), 0, 0, this.host.getSettings());
    if (gesture?.kind === 'move') {
      for (const stroke of this.session?.document.strokes ?? []) if (this.selected.has(stroke.id)) {
        const shift = this.placement(stroke);
        drawStroke(ctx, stroke, shift.dx + gesture.delta.x, shift.dy + gesture.delta.y, this.host.getSettings());
      }
    }
    if (gesture?.kind === 'lasso' && gesture.points.length) {
      ctx.save(); ctx.strokeStyle = '#4f8eff'; ctx.fillStyle = 'rgba(79,142,255,.08)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); gesture.points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    }
    const bounds = this.selectionBounds();
    if (bounds && this.host.getSettings().tool === 'lasso') {
      const delta = gesture?.kind === 'move' ? gesture.delta : { x: 0, y: 0 };
      ctx.save(); ctx.strokeStyle = '#4f8eff'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.strokeRect(bounds.x + delta.x - 5, bounds.y + delta.y - 5, Math.max(10, bounds.width + 10), Math.max(10, bounds.height + 10)); ctx.restore();
    }
  }

  private previewStroke(gesture: Gesture): Stroke {
    const stroke = gesture.stroke!;
    return SHAPES.has(gesture.tool) ? { ...stroke, points: shapePoints(stroke.tool, gesture.points[0], gesture.points[gesture.points.length - 1]) } : { ...stroke, points: gesture.points };
  }

  private point(event: PointerEvent, geometry: Geometry): Point {
    return { x: (event.clientX - geometry.left) / geometry.scale + geometry.scrollX, y: (event.clientY - geometry.top) / geometry.scale + geometry.scrollY, pressure: event.pressure > 0 ? event.pressure : 0.5, t: event.timeStamp };
  }

  private anchorAt(point: Point, geometry: Geometry): Anchor | undefined {
    const client = { x: (point.x - geometry.scrollX) * geometry.scale + geometry.left, y: (point.y - geometry.scrollY) * geometry.scale + geometry.top };
    const position = this.view.posAtCoords(client, false);
    if (position == null) return undefined;
    const line = this.view.state.doc.lineAt(position);
    let from = line.from, to = line.to;
    const word = this.view.state.wordAt(position);
    const nearest = this.view.coordsAtPos(position);
    // Annotation starts near a typed word follow that word through edits earlier on its line.
    // Margin and blank-space strokes follow the line instead of an arbitrary distant word.
    if (word && nearest && client.y >= nearest.top - 12 && client.y <= nearest.bottom + 12 && Math.abs(client.x - nearest.left) < 24) { from = word.from; to = word.to; }
    const coords = this.view.coordsAtPos(from);
    if (!coords) return undefined;
    return createAnchor(this.view.state.doc.toString(), from, to, (coords.left - geometry.left) / geometry.scale + geometry.scrollX, (coords.top - geometry.top) / geometry.scale + geometry.scrollY);
  }

  private isControl(event: Event): boolean {
    return event.composedPath().some(target => target instanceof this.win.Element && target.matches('.inkspace-toolbar-host,.inkspace-selection-tools,.inkspace-orphan-status'));
  }

  private consume(event: PointerEvent): void { if (event.cancelable) event.preventDefault(); event.stopPropagation(); }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.isControl(event)) return;
    // Obsidian can reuse a view for a different file without changing its text.
    // Re-resolve here as well, so the first pen stroke can never enter the previous file.
    this.bindSession();
    if (event.pointerType === 'touch') {
      if (this.gesture?.pointerId != null) { if (event.cancelable) event.preventDefault(); event.stopPropagation(); }
      return;
    }
    const settings = this.host.getSettings();
    if (!settings.enabled || settings.tool === 'text' || !this.session || this.gesture) return;
    if (event.pointerType !== 'pen' && !(event.pointerType === 'mouse' && settings.mouseDrawing && event.button === 0)) return;
    const geometry = this.readGeometry();
    this.pinch = null;
    this.geometry = geometry;
    const point = this.point(event, geometry);
    const tool: Tool = event.pointerType === 'pen' && (event.button === 5 || (event.buttons & 32) !== 0) ? 'eraser' : settings.tool;
    const bounds = this.selectionBounds();
    const move = tool === 'lasso' && bounds && point.x >= bounds.x - 8 && point.x <= bounds.x + bounds.width + 8 && point.y >= bounds.y - 8 && point.y <= bounds.y + bounds.height + 8;
    const kind: Gesture['kind'] = tool === 'eraser' ? 'erase' : tool === 'lasso' ? move ? 'move' : 'lasso' : 'draw';
    const stabilizer = kind === 'draw' && (tool === 'pen' || tool === 'highlighter') ? createStrokeStabilizer(settings.stabilization) : undefined;
    const first = stabilizer?.next(point) ?? point;
    const stroke: Stroke | undefined = kind === 'draw' ? { id: createId(), tool: tool as StrokeTool, points: [point], color: settings.color, width: tool === 'highlighter' ? settings.highlighterWidth : settings.penWidth, opacity: tool === 'highlighter' ? settings.highlighterOpacity : 1, smoothing: settings.smoothing, usePressure: settings.usePressure, anchor: this.anchorAt(point, geometry), updatedAt: Date.now() } : undefined;
    this.gesture = { pointerId: event.pointerId, kind, tool, points: [first], stroke, stabilizer, lastInput: point, erased: new Set(), origin: point, delta: { x: 0, y: 0 }, geometry, session: this.session };
    this.consume(event);
    try { this.view.dom.setPointerCapture(event.pointerId); } catch { /* Document listeners still finish the gesture when capture is unavailable. */ }
    if (kind === 'erase') this.eraseAt(point);
    if (kind === 'lasso') { this.selected.clear(); this.updateSelectionUi(); }
    this.invalidate(kind === 'move');
  };

  private onPointerMove = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    this.consume(event);
    let samples: PointerEvent[] = [event];
    if (typeof event.getCoalescedEvents === 'function') {
      const coalesced = event.getCoalescedEvents();
      if (coalesced.length) {
        samples = [...coalesced];
        const last = coalesced[coalesced.length - 1];
        if (last.clientX !== event.clientX || last.clientY !== event.clientY || last.timeStamp !== event.timeStamp || last.pressure !== event.pressure) samples.push(event);
      }
    }
    for (const sample of samples) {
      const raw = this.point(sample, this.geometry ?? gesture.geometry);
      if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) continue;
      // A lift or its coalesced history can report zero pressure. Keep the last
      // contact pressure rather than introducing an artificial endpoint bulge.
      if (sample.pressure <= 0) raw.pressure = gesture.lastInput.pressure;
      gesture.lastInput = raw;
      const point = gesture.stabilizer?.next(raw) ?? raw;
      if (gesture.kind === 'move') gesture.delta = { x: point.x - gesture.origin.x, y: point.y - gesture.origin.y };
      else if (gesture.kind === 'erase') this.eraseAt(point);
      else {
        const previous = gesture.points[gesture.points.length - 1];
        if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.15) {
          if (SHAPES.has(gesture.tool)) gesture.points = [gesture.points[0], point]; else gesture.points.push(point);
        }
      }
    }
    this.invalidate(false);
  };

  private onPointerUp = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    this.onPointerMove(event);
    this.gesture = null;
    if (gesture.session === this.session) {
      if (gesture.kind === 'draw' && gesture.stroke) {
        const stroke = this.previewStroke(gesture);
        // A hardware keyboard can edit during a pen gesture. Bind the completed mark to
        // the current visible text instead of retaining a pre-edit character position.
        stroke.anchor = this.anchorAt(stroke.points[0], this.geometry ?? gesture.geometry);
        this.mutate(() => gesture.session.add([stroke]), 'This mark could not be saved', [stroke]);
      }
      if (gesture.kind === 'erase' && gesture.erased.size) this.mutate(() => gesture.session.replace(gesture.session.document.strokes.filter(stroke => !gesture.erased.has(stroke.id)), 'Erase ink'), 'Ink could not be erased');
      if (gesture.kind === 'lasso') this.selectPolygon(gesture.points);
      if (gesture.kind === 'move' && Math.hypot(gesture.delta.x, gesture.delta.y) > 0.5) this.moveSelection(gesture.delta.x, gesture.delta.y);
    }
    try { this.view.dom.releasePointerCapture(event.pointerId); } catch { /* Already released. */ }
    this.updateSelectionUi();
    this.invalidate();
  };

  private onPointerCancel = (event: PointerEvent): void => { if (event.pointerId === this.gesture?.pointerId) this.cancelGesture(); };
  private onLostCapture = (event: PointerEvent): void => { if (event.pointerId === this.gesture?.pointerId) this.cancelGesture(); };
  private onTouch = (event: TouchEvent): void => {
    const settings = this.host.getSettings();
    if (!settings.enabled || this.isControl(event)) return;
    const stylus = Array.from(event.changedTouches).some(touch => (touch as Touch & { touchType?: string }).touchType === 'stylus');
    if ((stylus && settings.tool !== 'text') || this.gesture) {
      this.pinch = null;
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (!this.zoomAvailable || event.touches.length !== 2 || Array.from(event.touches).some(touch => (touch as Touch & { touchType?: string }).touchType === 'stylus')) { this.pinch = null; return; }
    const [a, b] = Array.from(event.touches);
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (distance < 1) return;
    const centerX = (a.clientX + b.clientX) / 2, centerY = (a.clientY + b.clientY) / 2;
    const geometry = this.readGeometry();
    if (!this.pinch) {
      this.pinch = { distance, zoom: this.appliedZoom, x: (centerX - geometry.left) / geometry.scale + geometry.scrollX, y: (centerY - geometry.top) / geometry.scale + geometry.scrollY };
    } else if (event.type === 'touchmove') {
      this.pendingZoom = { x: this.pinch.x, y: this.pinch.y, screenX: centerX - geometry.left, screenY: centerY - geometry.top };
      this.host.updateSettings({ zoom: Math.max(0.4, Math.min(2, this.pinch.zoom * distance / this.pinch.distance)) });
      this.measure();
    }
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
  };
  private onTouchEnd = (event: TouchEvent): void => { if (event.touches.length !== 2) this.pinch = null; };
  private onScroll = (): void => this.measure();
  private onResize = (): void => this.measure();
  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { this.cancelGesture(); this.selected.clear(); this.updateSelectionUi(); this.invalidate(false); }
    // All typing, cursor keys, and normal text undo stay with CodeMirror.
  };

  private cancelGesture(): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (gesture) { try { this.view.dom.releasePointerCapture(gesture.pointerId); } catch { /* No active capture. */ } }
    this.invalidate();
  }

  private eraseAt(point: Point): void {
    const gesture = this.gesture;
    if (!gesture || !this.session) return;
    let changed = false;
    for (const stroke of this.session.document.strokes) {
      if (gesture.erased.has(stroke.id)) continue;
      const shift = this.placement(stroke);
      if (hitStroke(stroke, { x: point.x - shift.dx, y: point.y - shift.dy }, this.host.getSettings().eraserSize / 2)) { gesture.erased.add(stroke.id); changed = true; }
    }
    if (changed) this.invalidate();
  }

  private selectPolygon(polygon: Point[]): void {
    this.selected.clear();
    if (polygon.length < 3) return;
    for (const stroke of this.session?.document.strokes ?? []) {
      const shift = this.placement(stroke);
      const bounds = strokeBounds(stroke);
      const probes = [...stroke.points, { x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY }, { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY }, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }];
      if (probes.some(point => polygonContains({ x: point.x + shift.dx, y: point.y + shift.dy }, polygon))) this.selected.add(stroke.id);
    }
  }

  private selectionBounds(): { x: number; y: number; width: number; height: number } | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const stroke of this.session?.document.strokes ?? []) if (this.selected.has(stroke.id)) {
      const shift = this.placement(stroke);
      const bounds = strokeBounds(stroke);
      minX = Math.min(minX, bounds.minX + shift.dx); minY = Math.min(minY, bounds.minY + shift.dy);
      maxX = Math.max(maxX, bounds.maxX + shift.dx); maxY = Math.max(maxY, bounds.maxY + shift.dy);
    }
    return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
  }

  private relocated(stroke: Stroke, dx: number, dy: number): Stroke {
    const shift = this.placement(stroke);
    const moved = translateStrokes([stroke], shift.dx + dx, shift.dy + dy)[0];
    const geometry = this.geometry;
    return { ...moved, anchor: geometry && moved.points.length ? this.anchorAt(moved.points[0], geometry) : undefined, updatedAt: Date.now() };
  }

  private moveSelection(dx: number, dy: number): void {
    if (!this.session) return;
    this.mutate(() => this.session!.replace(this.session!.document.strokes.map(stroke => this.selected.has(stroke.id) ? this.relocated(stroke, dx, dy) : stroke), 'Move ink'), 'Ink could not be moved');
  }

  private copySelection(): void {
    if (!this.session) return;
    const copies = this.session.document.strokes.filter(stroke => this.selected.has(stroke.id)).map(stroke => ({ ...this.relocated(stroke, 18, 18), id: createId() }));
    if (this.mutate(() => this.session!.add(copies), 'The copied ink could not be saved', copies)) this.selected = new Set(copies.map(stroke => stroke.id));
    this.updateSelectionUi();
  }

  private deleteSelection(): void {
    if (!this.session || !this.selected.size) return;
    if (this.mutate(() => this.session!.replace(this.session!.document.strokes.filter(stroke => !this.selected.has(stroke.id)), 'Delete ink'), 'Ink could not be deleted')) this.selected.clear();
    this.updateSelectionUi();
  }

  /** Export uses the same document-coordinate translations as drawing, lasso, and erasing. */
  exportSvg(): string {
    const strokes = this.visibleStrokes().map(stroke => {
      const shift = this.placement(stroke);
      return translateStrokes([stroke], shift.dx, shift.dy)[0];
    });
    const bounds = strokes.map(strokeBounds);
    const width = Math.max(this.host.getSettings().writingWidth, this.view.contentDOM.offsetWidth, ...bounds.map(box => box.maxX + 20));
    const height = Math.max(1, this.view.contentDOM.offsetHeight, ...bounds.map(box => box.maxY + 20));
    return strokesToSvg(strokes, width, height);
  }

  private downloadSvg(): void {
    if (!this.session) return;
    const blob = new Blob([this.exportSvg()], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = this.doc.createElement('a');
    link.href = url;
    link.download = `${this.session.path.split('/').pop()?.replace(/\.md$/i, '') ?? 'note'}-ink.svg`;
    link.click();
    this.win.setTimeout(() => URL.revokeObjectURL(url), 30000);
    this.host.status('Exported ink as SVG. This file contains the ink layer; your editable Markdown remains in the vault.');
  }

  refresh(): void { if (!this.destroyed) { this.bindSession(); this.measure(); } }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    ++this.generation;
    editors.get(this.host)?.delete(this);
    this.cancelGesture();
    if (this.frame) this.win.cancelAnimationFrame(this.frame);
    this.sessionCleanup?.(); this.settingsCleanup(); this.toolbarCleanup?.();
    this.resizeObserver?.disconnect();
    this.view.dom.removeEventListener('pointerdown', this.onPointerDown, true);
    this.doc.removeEventListener('pointermove', this.onPointerMove, true);
    this.doc.removeEventListener('pointerup', this.onPointerUp, true);
    this.doc.removeEventListener('pointercancel', this.onPointerCancel, true);
    this.view.dom.removeEventListener('lostpointercapture', this.onLostCapture, true);
    this.view.dom.removeEventListener('touchstart', this.onTouch, true);
    this.view.dom.removeEventListener('touchmove', this.onTouch, true);
    this.view.dom.removeEventListener('touchend', this.onTouchEnd, true);
    this.view.dom.removeEventListener('touchcancel', this.onTouchEnd, true);
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.view.dom.removeEventListener('keydown', this.onKeyDown, true);
    this.win.removeEventListener('resize', this.onResize);
    this.win.visualViewport?.removeEventListener('resize', this.onResize);
    this.win.visualViewport?.removeEventListener('scroll', this.onResize);
    this.overlay.remove(); this.toolbarHost.remove(); this.selectionTools.remove(); this.orphanStatus.remove();
    this.view.dom.classList.remove('inkspace-editor', 'inkspace-stable-layout', 'inkspace-enabled', 'inkspace-paper-ruled', 'inkspace-paper-grid', 'inkspace-paper-dots');
    this.view.dom.style.removeProperty('--inkspace-writing-width');
    this.view.dom.style.removeProperty('--inkspace-toolbar-height');
    if (this.originalZoom) this.view.contentDOM.style.setProperty('zoom', this.originalZoom); else this.view.contentDOM.style.removeProperty('zoom');
    this.restoreTransform();
    delete this.view.dom.dataset.inkspacePaper;
    delete this.view.dom.dataset.inkspaceZoomMode;
    this.view.dom.style.position = this.originalPosition;
  }
}

export function inkspaceExtension(host: InkHost): Extension {
  return [
    // CodeMirror owns its root class attribute and rewrites it on editor updates.
    // Register these through its facet so layout/paper styles survive typing and remeasurement.
    EditorView.editorAttributes.of(() => {
      const settings = host.getSettings();
      return { class: ['inkspace-editor', settings.enabled ? 'inkspace-enabled' : '', settings.stableLayout ? 'inkspace-stable-layout' : '', settings.paper === 'plain' ? '' : `inkspace-paper-${settings.paper}`].filter(Boolean).join(' ') };
    }),
    ViewPlugin.define(view => new InkEditor(view, host)),
  ];
}

/** Call on Obsidian file-open/layout events; avoids polling and handles same-text file changes. */
export function refreshInkspaceEditors(host: InkHost): void {
  editors.get(host)?.forEach(editor => editor.refresh());
}
