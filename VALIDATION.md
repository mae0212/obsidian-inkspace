# Validation — Inkspace 0.2.0

Release candidate checked on 19 October 2026.

## Automated checks

- TypeScript strict checking and mobile-compatible browser bundle build.
- 52 unit/integration tests covering document validation and capacity boundaries, immutable vectors/history, anchors, save serialization/retry, merging during concurrent writes, conflict recovery, note/folder renaming, PDF input/export, PDF/ZIP/image import, and saved-style validation/migration/independent widths.
- Actual editor extension exercised in Edge and Playwright WebKit 26 at desktop, 820px tablet, 600px dark-theme, and 390px narrow layouts.
- Direct pen events over existing text; keyboard typing; insertions above ink; undo/redo; save/reopen; note switching; no browser runtime errors.
- Zoom at 60%, 100%, and 140%: ink/text alignment, unchanged saved vectors, canonical new strokes, erasing and lasso movement/copy/deletion, and toolbar clearance.
- Synthetic two-finger pinch events, single-finger pass-through, and zoom restoration on disable/unload.
- Touch-enabled Edge and WebKit checks for thickness presets, independent tool limits, exact numeric entry, unfinished/invalid input, caret preservation and continued typing, saved-style capture/recall/reload, and unchanged existing strokes.
- Toolbar pointer/touch isolation, 44px touch controls, popup bounds at tablet/narrow/short viewport sizes and inside clipped `contain:strict` panes, standalone PDF toolbar mounting, and writing-space insertion with native undo and mapped ink anchors.
- Rejected editor mutations preserve saved ink, display recovery ink and an unsaved badge, and include rejected new marks in SVG export without uncaught runtime errors.
- PDFium pixel checks from 0.1.0 covered ink placement on cropped PDFs rotated 0°, 90°, 180°, and 270°, with original text remaining extractable. The PDF export implementation is unchanged in this update.

## Real Windows Obsidian

An isolated vault/profile in Obsidian 1.10.6 was used. The user's normal vault was not changed. The original release verified the following core behavior:

- Plugin loaded in the real Markdown editor.
- Pen/highlighter/ellipse marks appeared over editable text.
- Native keyboard editing saved with the ink.
- After closing the note and reconstructing the plugin, text and marks reopened from disk.
- The host's PDF.js rendered a source PDF; editable ink reopened and exported to a valid annotated PDF.

The 0.2.0 bundle was additionally checked in the real host:

- Preset, minus/plus, and exact sizing; unfinished numeric edits survive refresh; caret position remains intact.
- Older settings without saved styles migrate to three defaults. Captured pen/highlighter styles persist through the real settings save and plugin reload while tool widths remain independent.
- The writing-space shortcut adds eight newlines, and native text undo restores the original note.
- Size popups stay within the actual clipped workspace pane in Markdown and PDF views, including a short 820×430 window. Popup buttons meet the 44px minimum. No runtime errors were observed.

## Still requires physical-device testing

No physical iPad was controlled in this session. Desktop WebKit and synthetic pen/touch events do not verify Apple Pencil latency, palm rejection, iPadOS keyboard focus, rapid real pen lifts, or hardware gesture cancellation. Actual iPad-to-Windows vault syncing also needs a device round trip with the selected sync service.

## Defined limits

- Drawing surface: Markdown editing / Live Preview, plus the Inkspace PDF view. Reading mode and arbitrary third-party views are not drawing surfaces.
- Layout: word/line anchors handle normal insertions; heavy rewriting, folding, and wrapping can require lasso repositioning. Deleted/ambiguous anchors preserve and flag marks.
- Imported Goodnotes ink stays in the exported PDF background. Proprietary formats, audio/OCR migration, PDF text boxes, and lossless native-stroke conversion are unsupported.
- SVG exports the ink layer. Standard keyboard text undo and toolbar ink undo remain separate.
- Each note supports up to 100,000 strokes, 2,000,000 sampled points total, and 250,000 points per stroke. The ink sidecar source snapshot supports 10,000,000 characters. Save errors preserve the previous file and are retryable; native text editing remains available.

## Reproduce

Run `pnpm install`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Start `pnpm preview`, then run `node scripts/browser-test.mjs`, `node scripts/zoom-test.mjs`, and `node scripts/toolbar-test.mjs` from a second terminal. Set `INKSPACE_BROWSER=webkit` for the second browser engine. `python scripts/verify-pdf-export.py` additionally needs pypdfium2 and pypdf.
