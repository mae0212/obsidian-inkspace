# Validation — Inkspace 0.1.0

Release candidate checked on 18 October 2026.

## Automated checks

- TypeScript strict checking and mobile-compatible browser bundle build.
- 48 unit/integration tests covering document validation and capacity boundaries, immutable vectors/history, anchors, save serialization/retry, merging during concurrent writes, conflict recovery, note/folder renaming, PDF input/export, and PDF/ZIP/image import.
- Actual editor extension exercised in Edge and Playwright WebKit 26 at desktop, 820px tablet, 600px dark-theme, and 390px narrow layouts.
- Direct pen events over existing text; keyboard typing; insertions above ink; undo/redo; save/reopen; note switching; no browser runtime errors.
- Zoom at 60%, 100%, and 140%: ink/text alignment, unchanged saved vectors, canonical new strokes, erasing and lasso movement/copy/deletion, and toolbar clearance.
- Synthetic two-finger pinch events, single-finger pass-through, and zoom restoration on disable/unload.
- Rejected editor mutations preserve saved ink, display recovery ink and an unsaved badge, and include rejected new marks in SVG export without uncaught runtime errors.
- PDFium pixel checks for ink placement on cropped PDFs rotated 0°, 90°, 180°, and 270°. Original text remains extractable.

## Real Windows Obsidian

An isolated vault/profile in Obsidian 1.10.6 was used. The user's normal vault was not changed.

- Plugin loaded in the real Markdown editor.
- Pen/highlighter/ellipse marks appeared over editable text.
- Native keyboard editing saved with the ink.
- After closing the note and reconstructing the plugin, text and marks reopened from disk.
- The host's PDF.js rendered a source PDF; editable ink reopened and exported to a valid annotated PDF.

## Still requires physical-device testing

No physical iPad was controlled in this session. Desktop WebKit and synthetic pen/touch events do not verify Apple Pencil latency, palm rejection, iPadOS keyboard focus, rapid real pen lifts, or hardware gesture cancellation. Actual iPad-to-Windows vault syncing also needs a device round trip with the selected sync service.

## Defined limits

- Drawing surface: Markdown editing / Live Preview, plus the Inkspace PDF view. Reading mode and arbitrary third-party views are not drawing surfaces.
- Layout: word/line anchors handle normal insertions; heavy rewriting, folding, and wrapping can require lasso repositioning. Deleted/ambiguous anchors preserve and flag marks.
- Imported Goodnotes ink stays in the exported PDF background. Proprietary formats, audio/OCR migration, PDF text boxes, and lossless native-stroke conversion are unsupported.
- SVG exports the ink layer. Standard keyboard text undo and toolbar ink undo remain separate.
- Each note supports up to 100,000 strokes, 2,000,000 sampled points total, and 250,000 points per stroke. The ink sidecar source snapshot supports 10,000,000 characters. Save errors preserve the previous file and are retryable; native text editing remains available.

## Reproduce

Run `pnpm install`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Start `pnpm preview`, then run `node scripts/browser-test.mjs` and `node scripts/zoom-test.mjs` from a second terminal. Set `INKSPACE_BROWSER=webkit` for the second browser engine. `python scripts/verify-pdf-export.py` additionally needs pypdfium2 and pypdf.
