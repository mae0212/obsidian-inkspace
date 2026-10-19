# Changes

## 0.3.0 — 19 October 2026

- Add speed-adaptive handwriting stabilization for new pen and highlighter strokes in Markdown and PDFs. Slow movements receive more smoothing; faster curves remain responsive, with a bounded distance between input and ink.
- Choose Off, Light, Natural, or Strong using large tap controls in the size popup or the plugin settings. Natural is the default for new and upgraded installations.
- Process coalesced pen samples and the final pen-lift sample, keeping the same filtered geometry while drawing, saving, reopening, erasing, selecting, and exporting.
- Preserve the last contact pressure on pen lift to avoid an artificial thickness change.

Existing strokes keep their saved appearance. The writing feel still needs confirmation with a physical Apple Pencil; this is not a claim to reproduce Notability's proprietary ink engine.

## 0.2.0 — 19 October 2026

- Replace the small horizontal thickness slider with tap controls, presets, and exact numeric entry to avoid requiring the swipe that can open Obsidian's sidebar on iPad.
- Keep independent size ranges for pen/shapes, highlighter, and eraser.
- Add three saved pen/highlighter styles, including color, width, and highlighter opacity.
- Enlarge tool and color hit areas for touch input.
- Add a writing-space shortcut to the note toolbar's More menu.
- Update installation instructions for the now-public repository and existing 0.1.0 installations.

The note and ink file formats are unchanged. Actual iPad gesture behavior still needs device verification.

## 0.1.0 — 18 October 2026

- First installable prototype: direct ink over editable Markdown; pen, highlighter, eraser, shapes, and lasso; zoom and paper backgrounds; portable sidecars and recovery; PDF annotation/export; Goodnotes PDF/image/ZIP import.
