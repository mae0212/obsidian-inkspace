import test from 'node:test';
import assert from 'node:assert/strict';
import { captureFavoriteStyle, favoriteStylePatch, normalizeFavoriteStyles } from '../src/presets';
import { DEFAULT_FAVORITE_STYLES, DEFAULT_SETTINGS, type InkPreset, type InkSettings } from '../src/types';

const settings = (patch: Partial<InkSettings> = {}): InkSettings => ({ ...DEFAULT_SETTINGS, favoriteStyles: normalizeFavoriteStyles(undefined), ...patch });

test('older, missing, malformed and extra settings normalize to exactly three independent slots', () => {
  for (const input of [undefined, null, {}, 'wrong', []]) {
    const favorites = normalizeFavoriteStyles(input);
    assert.equal(favorites.length, 3);
    assert.deepEqual(favorites, DEFAULT_FAVORITE_STYLES);
    favorites[0].color = '#000000';
    assert.equal(DEFAULT_FAVORITE_STYLES[0].color, '#2563eb');
  }
  const valid: InkPreset = { name: ' Purple pen ', tool: 'pen', color: '#ABCDEF', width: 4 };
  const favorites = normalizeFavoriteStyles([valid, { bad: true }, DEFAULT_FAVORITE_STYLES[2], valid]);
  assert.equal(favorites.length, 3);
  assert.deepEqual(favorites[0], { name: 'Purple pen', tool: 'pen', color: '#abcdef', width: 4 });
  assert.deepEqual(favorites[1], DEFAULT_FAVORITE_STYLES[1]);
  valid.color = '#000000'; favorites[2].opacity = .6;
  assert.equal(favorites[0].color, '#abcdef');
  assert.equal(DEFAULT_FAVORITE_STYLES[2].opacity, .27);
});

test('slot validation enforces tool-specific ranges, colors, opacity and short names', () => {
  const pen = { name: 'Pen', tool: 'pen', color: '#2563eb', width: .5 };
  const highlighter = { name: 'Highlighter', tool: 'highlighter', color: '#eab308', width: 64, opacity: .05 };
  assert.equal(normalizeFavoriteStyles([pen, { ...pen, width: 32 }, highlighter])[2].width, 64);
  for (const invalid of [
    { ...pen, width: .49 }, { ...pen, width: 32.01 }, { ...pen, width: NaN },
    { ...pen, color: '#fff' }, { ...pen, color: 'url(bad)' }, { ...pen, tool: 'eraser' },
    { ...pen, name: '' }, { ...pen, name: 'Bad\nname' },
    { ...highlighter, width: 1.99 }, { ...highlighter, width: 64.01 },
    { ...highlighter, opacity: .049 }, { ...highlighter, opacity: .651 },
  ]) assert.deepEqual(normalizeFavoriteStyles([invalid])[0], DEFAULT_FAVORITE_STYLES[0]);
  assert.equal(normalizeFavoriteStyles([{ ...pen, name: 'x'.repeat(60) }])[0].name.length, 30);
  assert.equal(normalizeFavoriteStyles([highlighter])[0].opacity, .05);
  assert.equal(normalizeFavoriteStyles([{ ...highlighter, opacity: .65 }])[0].opacity, .65);
  assert.equal(normalizeFavoriteStyles([{ ...highlighter, opacity: undefined }])[0].opacity, .27);
});

test('capture takes independent pen/highlighter snapshots, including shape styling', () => {
  for (const tool of ['pen', 'line', 'arrow', 'rectangle', 'ellipse'] as const) {
    const s = settings({ tool, color: '#9333ea', penWidth: 7, highlighterWidth: 30 });
    const snapshot = captureFavoriteStyle(s)!;
    assert.deepEqual(snapshot, { name: 'Pen', tool: 'pen', color: '#9333ea', width: 7 });
    s.color = '#000000'; s.penWidth = 2;
    assert.equal(snapshot.width, 7); assert.equal(snapshot.color, '#9333ea');
  }
  const s = settings({ tool: 'highlighter', highlighterWidth: 35, highlighterOpacity: .4 });
  assert.deepEqual(captureFavoriteStyle(s), { name: 'Highlighter', tool: 'highlighter', color: '#2563eb', width: 35, opacity: .4 });
  for (const tool of ['eraser', 'text', 'lasso'] as const) assert.equal(captureFavoriteStyle(settings({ tool })), null);
});

test('applying styles preserves independent tool widths and leaves presets and saved ink untouched', () => {
  const s = settings({ penWidth: 5, highlighterWidth: 36, eraserSize: 28, enabled: false });
  const preset: InkPreset = { name: 'Study highlight', tool: 'highlighter', color: '#eab308', width: 22, opacity: .3 };
  const before = structuredClone(preset);
  const appliedHighlighter = { ...s, ...favoriteStylePatch(preset) };
  assert.equal(appliedHighlighter.penWidth, 5); assert.equal(appliedHighlighter.eraserSize, 28);
  assert.equal(appliedHighlighter.highlighterWidth, 22); assert.equal(appliedHighlighter.highlighterOpacity, .3);
  assert.equal(appliedHighlighter.enabled, true); assert.equal(appliedHighlighter.tool, 'highlighter');
  const appliedPen = { ...appliedHighlighter, ...favoriteStylePatch({ name: 'Fine pen', tool: 'pen', color: '#dc2626', width: 1.5 }) };
  assert.equal(appliedPen.highlighterWidth, 22); assert.equal(appliedPen.highlighterOpacity, .3);
  assert.equal(appliedPen.penWidth, 1.5); assert.equal(appliedPen.tool, 'pen');
  assert.deepEqual(preset, before);
  assert.equal(s.penWidth, 5); assert.equal(s.enabled, false);
  // No helper accepts document/stroke references; using a favorite only returns a settings patch.
  assert.equal('strokes' in favoriteStylePatch(preset), false);
});
