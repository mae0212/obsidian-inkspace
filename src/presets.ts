import { DEFAULT_FAVORITE_STYLES, type InkPreset, type InkSettings } from './types';

const COLOR = /^#[0-9a-f]{6}$/i;
function normalizeStyle(input: unknown, fallback: Readonly<InkPreset>): InkPreset {
  const fail = (): InkPreset => ({ ...fallback });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  const style = input as Record<string, unknown>;
  if (style.tool !== 'pen' && style.tool !== 'highlighter') return fail();
  if (typeof style.color !== 'string' || !COLOR.test(style.color)) return fail();
  const [minimum, maximum] = style.tool === 'highlighter' ? [2, 64] : [.5, 32];
  if (typeof style.width !== 'number' || !Number.isFinite(style.width) || style.width < minimum || style.width > maximum) return fail();
  if (typeof style.name !== 'string' || !style.name.trim() || /[\u0000-\u001f\u007f]/.test(style.name)) return fail();
  const opacity = style.opacity === undefined ? .27 : style.opacity;
  if (style.tool === 'highlighter' && (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < .05 || opacity > .65)) return fail();
  return { name: style.name.trim().slice(0, 30), tool: style.tool, color: style.color.toLowerCase(), width: style.width, ...(style.tool === 'highlighter' ? { opacity: opacity as number } : {}) };
}

/** Always returns three independent snapshots, including when upgrading older settings. */
export function normalizeFavoriteStyles(input: unknown): InkPreset[] {
  const slots = Array.isArray(input) ? input : [];
  return DEFAULT_FAVORITE_STYLES.map((fallback, index) => normalizeStyle(slots[index], fallback));
}

/** Shapes share pen styling; capture never reads or mutates saved strokes. */
export function captureFavoriteStyle(settings: InkSettings): InkPreset | null {
  if (settings.tool === 'eraser' || settings.tool === 'text' || settings.tool === 'lasso') return null;
  const highlighter = settings.tool === 'highlighter';
  return normalizeStyle({ name: highlighter ? 'Highlighter' : 'Pen', tool: highlighter ? 'highlighter' : 'pen', color: settings.color, width: highlighter ? settings.highlighterWidth : settings.penWidth, ...(highlighter ? { opacity: settings.highlighterOpacity } : {}) }, DEFAULT_FAVORITE_STYLES[highlighter ? 2 : 0]);
}

/** Applying one style leaves the other tools' independent widths intact. */
export function favoriteStylePatch(preset: InkPreset): Partial<InkSettings> {
  const style = normalizeStyle(preset, DEFAULT_FAVORITE_STYLES[preset?.tool === 'highlighter' ? 2 : 0]);
  return style.tool === 'highlighter'
    ? { enabled: true, tool: 'highlighter', color: style.color, highlighterWidth: style.width, highlighterOpacity: style.opacity ?? .27 }
    : { enabled: true, tool: 'pen', color: style.color, penWidth: style.width };
}
