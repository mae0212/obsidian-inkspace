import { COLORS, type InkHost, type InkSession, type Tool, type ToolbarActions } from './types';
import { captureFavoriteStyle, favoriteStylePatch } from './presets';

const TOOLS: Array<[Tool, string, string]> = [
  ['text', 'Aa', 'Type and select text'], ['pen', '✎', 'Pen'], ['highlighter', '▰', 'Highlighter'],
  ['eraser', '⌫', 'Eraser'], ['lasso', '◌', 'Lasso selection'], ['line', '╱', 'Line'],
  ['arrow', '↗', 'Arrow'], ['rectangle', '▭', 'Rectangle'], ['ellipse', '◯', 'Ellipse'],
];
interface SizeSpec {
  key: 'penWidth' | 'highlighterWidth' | 'eraserSize';
  label: string;
  min: number;
  max: number;
  step: number;
  presets: number[];
}
function sizeSpec(tool: Tool): SizeSpec | null {
  if (tool === 'text' || tool === 'lasso') return null;
  if (tool === 'highlighter') return { key: 'highlighterWidth', label: 'Highlighter', min: 2, max: 64, step: 1, presets: [4, 10, 22, 40, 64] };
  if (tool === 'eraser') return { key: 'eraserSize', label: 'Eraser', min: 2, max: 100, step: 1, presets: [4, 10, 18, 40, 100] };
  return { key: 'penWidth', label: TOOLS.find(([name]) => name === tool)?.[2] ?? 'Pen', min: 0.5, max: 32, step: 0.5, presets: [0.5, 1, 2.5, 5, 10] };
}
let nextToolbar = 0;

export function createToolbar(host: InkHost, container: HTMLElement, session: () => InkSession | null, extra?: ToolbarActions): () => void {
  const doc = container.ownerDocument;
  const win = doc.defaultView ?? window;
  const cleanups: Array<() => void> = [];
  const listen = (target: EventTarget, type: string, listener: EventListener, options?: AddEventListenerOptions | boolean): void => {
    target.addEventListener(type, listener, options);
    cleanups.push(() => target.removeEventListener(type, listener, options));
  };
  const safely = (action: () => void): void => { try { action(); } catch (error) { host.status(String(error), true); } };
  const bar = doc.createElement('div');
  bar.className = 'inkspace-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Inkspace drawing tools');
  container.append(bar);
  const buttons = new Map<string, HTMLButtonElement>();
  const button = (parent: HTMLElement, label: string, text: string, action: () => void): HTMLButtonElement => {
    const element = doc.createElement('button');
    element.type = 'button';
    element.title = label;
    element.setAttribute('aria-label', label);
    element.textContent = text;
    element.addEventListener('click', () => safely(action));
    parent.append(element);
    return element;
  };
  for (const [tool, glyph, label] of TOOLS) buttons.set(tool, button(bar, label, glyph, () => host.updateSettings({ tool })));
  const separator = doc.createElement('span');
  separator.className = 'inkspace-separator';
  separator.setAttribute('aria-hidden', 'true');
  bar.append(separator);
  const palette = doc.createElement('div');
  palette.className = 'inkspace-palette';
  palette.setAttribute('aria-label', 'Ink colors');
  bar.append(palette);
  for (const color of COLORS) {
    const swatch = button(palette, `Ink color ${color}`, '', () => host.updateSettings({ color }));
    swatch.className = 'inkspace-swatch';
    const dot = doc.createElement('span');
    dot.className = 'inkspace-color-dot';
    dot.style.backgroundColor = color;
    dot.setAttribute('aria-hidden', 'true');
    swatch.append(dot);
    buttons.set(color, swatch);
  }
  const custom = doc.createElement('input');
  custom.type = 'color';
  custom.title = 'Custom ink color';
  custom.setAttribute('aria-label', custom.title);
  custom.className = 'inkspace-custom-color';
  custom.addEventListener('input', () => host.updateSettings({ color: custom.value }));
  bar.append(custom);

  // Size is tap-first: no horizontal drag is needed anywhere in this control.
  const sizeControl = doc.createElement('div');
  sizeControl.className = 'inkspace-size-control';
  bar.append(sizeControl);
  let sizeOpen = false;
  let numberDirty = false;
  let previousFocus: HTMLElement | null = null;
  let currentSizeKey: SizeSpec['key'] | undefined;
  const sizeTrigger = button(sizeControl, 'Stroke size', '', () => sizeOpen ? closeSize(true) : openSize());
  sizeTrigger.className = 'inkspace-size-trigger';
  sizeTrigger.setAttribute('aria-haspopup', 'dialog');
  sizeTrigger.setAttribute('aria-expanded', 'false');
  const popup = doc.createElement('div');
  popup.id = `inkspace-size-${++nextToolbar}`;
  popup.className = 'inkspace-size-popup';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Stroke size and saved styles');
  popup.hidden = true;
  sizeTrigger.setAttribute('aria-controls', popup.id);
  sizeControl.append(popup);
  const heading = doc.createElement('div');
  heading.className = 'inkspace-size-heading';
  const sizeTitle = doc.createElement('strong');
  heading.append(sizeTitle);
  button(heading, 'Close stroke size', '×', () => closeSize(true)).className = 'inkspace-size-close';
  popup.append(heading);
  const stepper = doc.createElement('div');
  stepper.className = 'inkspace-size-stepper';
  const decrease = button(stepper, 'Decrease stroke size', '−', () => changeSize(-1));
  const exact = doc.createElement('input');
  exact.type = 'number';
  exact.inputMode = 'decimal';
  exact.step = 'any';
  exact.className = 'inkspace-size-number';
  exact.setAttribute('aria-label', 'Exact stroke size');
  stepper.append(exact);
  const increase = button(stepper, 'Increase stroke size', '+', () => changeSize(1));
  popup.append(stepper);
  const error = doc.createElement('div');
  error.className = 'inkspace-size-error';
  error.setAttribute('aria-live', 'polite');
  popup.append(error);
  const presets = doc.createElement('div');
  presets.className = 'inkspace-size-presets';
  presets.setAttribute('aria-label', 'Stroke size presets');
  popup.append(presets);
  const favoritesHeading = doc.createElement('strong');
  favoritesHeading.className = 'inkspace-favorites-heading';
  favoritesHeading.textContent = 'Saved styles';
  popup.append(favoritesHeading);
  const favorites = doc.createElement('div');
  favorites.className = 'inkspace-favorites';
  popup.append(favorites);
  const favoriteButtons: Array<{ use: HTMLButtonElement; save: HTMLButtonElement; dot: HTMLSpanElement; label: HTMLSpanElement }> = [];
  for (let index = 0; index < 3; index++) {
    const row = doc.createElement('div');
    row.className = 'inkspace-favorite-row';
    const use = button(row, `Use saved style ${index + 1}`, '', () => {
      const preset = host.getSettings().favoriteStyles[index];
      if (!preset) return;
      numberDirty = false;
      host.updateSettings(favoriteStylePatch(preset));
    });
    use.className = 'inkspace-favorite-use';
    const dot = doc.createElement('span');
    dot.className = 'inkspace-color-dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = doc.createElement('span');
    use.append(dot, label);
    const save = button(row, `Save current style to slot ${index + 1}`, 'Save', () => {
      if (!commitNumber()) return;
      const captured = captureFavoriteStyle(host.getSettings());
      if (!captured) return;
      const favoriteStyles = [...host.getSettings().favoriteStyles];
      favoriteStyles[index] = captured;
      host.updateSettings({ favoriteStyles });
    });
    save.className = 'inkspace-favorite-save';
    favorites.append(row);
    favoriteButtons.push({ use, save, dot, label });
  }

  function numericValue(spec: SizeSpec): number | null {
    const value = exact.value.trim() ? Number(exact.value) : NaN;
    return Number.isFinite(value) ? Math.round(Math.max(spec.min, Math.min(spec.max, value)) * 1000) / 1000 : null;
  }
  function setSize(value: number, spec: SizeSpec): void {
    numberDirty = false;
    error.textContent = '';
    exact.removeAttribute('aria-invalid');
    host.updateSettings({ [spec.key]: Math.round(Math.max(spec.min, Math.min(spec.max, value)) * 1000) / 1000 });
  }
  function commitNumber(): boolean {
    const spec = sizeSpec(host.getSettings().tool);
    if (!spec || !numberDirty) return true;
    const value = numericValue(spec);
    if (value == null) {
      error.textContent = `Enter a size from ${spec.min} to ${spec.max}.`;
      exact.setAttribute('aria-invalid', 'true');
      return false;
    }
    setSize(value, spec);
    return true;
  }
  function changeSize(direction: -1 | 1): void {
    const settings = host.getSettings();
    const spec = sizeSpec(settings.tool);
    if (!spec) return;
    const value = numberDirty ? numericValue(spec) : settings[spec.key];
    setSize((value ?? settings[spec.key]) + direction * spec.step, spec);
  }
  function positionSize(): void {
    if (!sizeOpen) return;
    const viewport = win.visualViewport;
    let leftEdge = viewport?.offsetLeft ?? 0;
    let topEdge = viewport?.offsetTop ?? 0;
    let rightEdge = leftEdge + (viewport?.width ?? win.innerWidth);
    let bottomEdge = topEdge + (viewport?.height ?? win.innerHeight);
    // Obsidian's panes can use contain:strict, which both clips descendants and
    // makes fixed coordinates relative to the pane. Stay inside its visible region.
    for (let ancestor = popup.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = win.getComputedStyle(ancestor);
      const paintsInside = /(?:^|\s)(?:paint|strict|content)(?:\s|$)/.test(style.contain);
      const clipsX = paintsInside || style.overflowX !== 'visible';
      const clipsY = paintsInside || style.overflowY !== 'visible';
      if (!clipsX && !clipsY) continue;
      const rect = ancestor.getBoundingClientRect();
      const scaleX = ancestor.offsetWidth ? rect.width / ancestor.offsetWidth : 1;
      const scaleY = ancestor.offsetHeight ? rect.height / ancestor.offsetHeight : 1;
      const left = rect.left + ancestor.clientLeft * scaleX;
      const top = rect.top + ancestor.clientTop * scaleY;
      if (clipsX) {
        leftEdge = Math.max(leftEdge, left);
        rightEdge = Math.min(rightEdge, left + ancestor.clientWidth * scaleX);
      }
      if (clipsY) {
        topEdge = Math.max(topEdge, top);
        bottomEdge = Math.min(bottomEdge, top + ancestor.clientHeight * scaleY);
      }
    }
    leftEdge += 8; rightEdge -= 8; topEdge += 8; bottomEdge -= 8;
    popup.style.width = `${Math.max(44, Math.min(320, rightEdge - leftEdge))}px`;
    popup.style.maxHeight = `${Math.max(44, bottomEdge - topEdge)}px`;
    // Probe the actual fixed-position origin instead of assuming it is the viewport.
    // This also handles translated/scaled containing blocks without moving the popup
    // outside the toolbar's input-gesture boundary.
    popup.style.left = '0px';
    popup.style.top = '0px';
    const anchor = sizeTrigger.getBoundingClientRect();
    const rect = popup.getBoundingClientRect();
    const scaleX = popup.offsetWidth ? rect.width / popup.offsetWidth : 1;
    const scaleY = popup.offsetHeight ? rect.height / popup.offsetHeight : 1;
    const left = Math.max(leftEdge, Math.min(anchor.right - rect.width, rightEdge - rect.width));
    const below = anchor.bottom + 8;
    const above = anchor.top - rect.height - 8;
    const top = below + rect.height <= bottomEdge ? below : above >= topEdge ? above : topEdge;
    popup.style.left = `${(left - rect.left) / (scaleX || 1)}px`;
    popup.style.top = `${(top - rect.top) / (scaleY || 1)}px`;
  }
  function openSize(): void {
    if (!sizeSpec(host.getSettings().tool)) return;
    previousFocus = doc.activeElement instanceof win.HTMLElement ? doc.activeElement : null;
    numberDirty = false;
    error.textContent = '';
    exact.removeAttribute('aria-invalid');
    sizeOpen = true;
    popup.hidden = false;
    sizeTrigger.setAttribute('aria-expanded', 'true');
    more.open = false;
    update();
    positionSize();
  }
  function closeSize(commit: boolean, restoreFocus = true): void {
    if (!sizeOpen) return;
    if (commit) commitNumber();
    const inputHadFocus = doc.activeElement === exact;
    const popupHadFocus = popup.contains(doc.activeElement);
    numberDirty = false;
    sizeOpen = false;
    popup.hidden = true;
    sizeTrigger.setAttribute('aria-expanded', 'false');
    if (inputHadFocus && restoreFocus) (previousFocus?.isConnected ? previousFocus : sizeTrigger).focus({ preventScroll: true });
    else if (popupHadFocus && restoreFocus) sizeTrigger.focus({ preventScroll: true });
  }
  exact.addEventListener('input', () => { numberDirty = true; error.textContent = ''; exact.removeAttribute('aria-invalid'); });
  exact.addEventListener('change', () => { if (sizeOpen) commitNumber(); });
  exact.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); if (commitNumber()) closeSize(false); }
  });
  sizeTrigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); openSize(); decrease.focus({ preventScroll: true }); }
  });

  buttons.set('undo', button(bar, 'Undo ink', '↶', () => session()?.undo()));
  buttons.set('redo', button(bar, 'Redo ink', '↷', () => session()?.redo()));
  buttons.set('mouse', button(bar, 'Draw with mouse', '⌖', () => host.updateSettings({ mouseDrawing: !host.getSettings().mouseDrawing })));
  const more = doc.createElement('details');
  more.className = 'inkspace-more';
  const summary = doc.createElement('summary');
  summary.textContent = '•••';
  summary.title = 'More ink tools';
  summary.setAttribute('aria-label', summary.title);
  const menu = doc.createElement('div');
  menu.className = 'inkspace-more-menu';
  more.append(summary, menu);
  bar.append(more);
  more.addEventListener('toggle', () => {
    summary.setAttribute('aria-expanded', String(more.open));
    if (more.open) closeSize(true);
  });
  const menuButton = (label: string, action: () => void): void => { button(menu, label, label, () => { more.open = false; action(); }); };
  menuButton('Save ink now', () => { void session()?.flush().then(() => host.status('Ink saved.')).catch(error => host.status(String(error), true)); });
  menuButton('Stable writing layout', () => host.updateSettings({ stableLayout: !host.getSettings().stableLayout }));
  menuButton('Zoom in', () => host.updateSettings({ zoom: Math.min(2, host.getSettings().zoom + 0.1) }));
  menuButton('Zoom out', () => host.updateSettings({ zoom: Math.max(0.4, host.getSettings().zoom - 0.1) }));
  menuButton('Zoom: 100%', () => host.updateSettings({ zoom: 1 }));
  menuButton('Fit writing width', () => {
    const scroller = container.closest('.cm-editor')?.querySelector<HTMLElement>('.cm-scroller');
    if (scroller) host.updateSettings({ zoom: Math.max(0.4, Math.min(1, (scroller.clientWidth - 32) / host.getSettings().writingWidth)) });
  });
  if (extra?.insertSpace) menuButton('Add writing space below', extra.insertSpace);
  for (const paper of ['plain', 'ruled', 'grid', 'dots'] as const) menuButton(`Paper: ${paper}`, () => host.updateSettings({ paper }));
  if (extra?.exportSvg) menuButton('Export ink as SVG', extra.exportSvg);
  if (extra?.exportPdf) menuButton('Export annotated PDF', extra.exportPdf);
  const status = doc.createElement('span');
  status.className = 'inkspace-tool-status';
  status.setAttribute('aria-live', 'polite');
  bar.append(status);

  // Keep gestures inside the toolbar. Inputs can focus; the popup can scroll vertically.
  let touchStart: { x: number; y: number } | null = null;
  listen(bar, 'pointerdown', event => {
    event.stopPropagation();
    const target = event.target as Element | null;
    if (target?.closest('button,summary') && (event as PointerEvent).button === 0) event.preventDefault();
  }, true);
  // WebKit touch taps can still synthesize mousedown after a cancelled pointerdown.
  // Cancel its focus change on buttons; number and color inputs keep their native focus.
  listen(bar, 'mousedown', event => {
    event.stopPropagation();
    const target = event.target as Element | null;
    if (target?.closest('button,summary') && (event as MouseEvent).button === 0) event.preventDefault();
  }, true);
  listen(bar, 'pointermove', event => event.stopPropagation(), true);
  listen(bar, 'pointerup', event => event.stopPropagation(), true);
  listen(bar, 'pointercancel', event => event.stopPropagation(), true);
  listen(bar, 'touchstart', event => {
    event.stopPropagation();
    const first = (event as TouchEvent).touches[0];
    touchStart = first ? { x: first.clientX, y: first.clientY } : null;
  }, { capture: true, passive: true });
  listen(bar, 'touchmove', event => {
    event.stopPropagation();
    const first = (event as TouchEvent).touches[0];
    const dx = first && touchStart ? first.clientX - touchStart.x : 0;
    const dy = first && touchStart ? first.clientY - touchStart.y : 0;
    const insidePopup = popup.contains(event.target as Node);
    const canScroll = insidePopup && Math.abs(dy) > Math.abs(dx) && (dy > 0 ? popup.scrollTop > 0 : popup.scrollTop + popup.clientHeight < popup.scrollHeight - 1);
    if (!canScroll && event.cancelable) event.preventDefault();
  }, { capture: true, passive: false });
  listen(bar, 'touchend', event => { event.stopPropagation(); touchStart = null; }, true);
  listen(bar, 'touchcancel', event => { event.stopPropagation(); touchStart = null; }, true);
  listen(doc, 'pointerdown', event => {
    if (!bar.contains(event.target as Node)) { closeSize(true); more.open = false; }
  }, true);
  listen(doc, 'keydown', event => {
    if ((event as KeyboardEvent).key === 'Escape' && (sizeOpen || more.open)) {
      event.preventDefault(); event.stopPropagation(); closeSize(false); more.open = false;
    }
  }, true);
  listen(win, 'resize', () => positionSize());
  listen(doc, 'scroll', () => positionSize(), { capture: true, passive: true });
  if (win.visualViewport) {
    listen(win.visualViewport, 'resize', () => positionSize());
    listen(win.visualViewport, 'scroll', () => positionSize());
  }

  let unsubSession: (() => void) | undefined;
  let active: InkSession | null = null;
  function update(): void {
    const settings = host.getSettings();
    for (const [key, element] of buttons) {
      const selected = key === settings.tool || key === settings.color || (key === 'mouse' && settings.mouseDrawing);
      element.classList.toggle('is-active', selected);
      if (key !== 'undo' && key !== 'redo') element.setAttribute('aria-pressed', String(selected));
    }
    custom.value = settings.color;
    const spec = sizeSpec(settings.tool);
    sizeControl.hidden = !spec;
    if (!spec) closeSize(false);
    else {
      if (currentSizeKey !== spec.key) numberDirty = false;
      const value = settings[spec.key];
      sizeTrigger.textContent = `${spec.label} ${value}`;
      sizeTrigger.title = `Stroke size: ${spec.label}, ${value}`;
      sizeTrigger.setAttribute('aria-label', sizeTrigger.title);
      sizeTitle.textContent = `${spec.label} size`;
      exact.min = String(spec.min);
      exact.max = String(spec.max);
      if (!numberDirty) exact.value = String(value);
      decrease.disabled = value <= spec.min;
      increase.disabled = value >= spec.max;
      if (currentSizeKey !== spec.key || !presets.childElementCount) {
        presets.replaceChildren();
        for (const width of spec.presets) {
          const preset = button(presets, `Set stroke size to ${width}`, String(width), () => setSize(width, spec));
          preset.dataset.width = String(width);
        }
      }
      presets.querySelectorAll<HTMLButtonElement>('button').forEach(element => element.setAttribute('aria-pressed', String(Number(element.dataset.width) === value)));
      currentSizeKey = spec.key;
    }
    const canSave = captureFavoriteStyle(settings) !== null;
    favoriteButtons.forEach(({ use, save, dot, label }, index) => {
      const preset = settings.favoriteStyles[index];
      use.disabled = !preset;
      save.disabled = !canSave;
      if (!preset) return;
      label.textContent = `${preset.name} · ${preset.width}`;
      dot.style.backgroundColor = preset.color;
      use.setAttribute('aria-label', `Use saved style ${index + 1}: ${preset.name}`);
      use.title = `${preset.name}, size ${preset.width}`;
    });
    const current = session();
    if (current !== active) { unsubSession?.(); active = current; unsubSession = current?.subscribe(update); }
    buttons.get('undo')!.disabled = !current?.canUndo;
    buttons.get('redo')!.disabled = !current?.canRedo;
    status.textContent = settings.tool === 'text' ? 'Type' : settings.mouseDrawing ? 'Mouse + Pencil' : 'Pencil';
    if (sizeOpen) positionSize();
  }
  const unsubscribe = host.subscribeSettings(update);
  update();
  const timer = win.setInterval(update, 900);
  const editor = container.closest<HTMLElement>('.cm-editor');
  const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
    editor?.style.setProperty('--inkspace-toolbar-height', `${bar.getBoundingClientRect().height}px`);
    positionSize();
  }) : null;
  resize?.observe(bar);
  return () => {
    win.clearInterval(timer);
    resize?.disconnect();
    editor?.style.removeProperty('--inkspace-toolbar-height');
    unsubscribe();
    unsubSession?.();
    cleanups.forEach(cleanup => cleanup());
    bar.remove();
  };
}
