# Inkspace for Obsidian

Type and draw on the same note. Inkspace adds editable ink directly over Obsidian's normal Markdown editor, including existing text and images. One mobile-compatible plugin bundle serves iPad and Windows.

**Version 0.1.0 is an early prototype.** Automated editor, storage, import, and PDF checks are included. Apple Pencil latency and palm rejection must still be verified on a physical iPad; this release does not claim Goodnotes-identical performance.

## Features

- Direct handwriting over ordinary notes in editing / Live Preview mode; no embedded drawing block.
- Colored pens, custom colors, adjustable width, translucent highlighter, pressure option, and stored stroke smoothing.
- Stroke eraser; lasso selection, movement, copying, and deletion; separate ink undo/redo.
- Lines, arrows, rectangles, and ellipses.
- Consistent writing width, document zoom, two-finger pinch, and plain, ruled, grid, or dotted backgrounds.
- Offline PDF annotation with page navigation, zoom, and vector PDF export that preserves the source document.
- Import Goodnotes-exported PDFs, images, and ZIP folders while preserving hierarchy and avoiding overwrites.
- Editable vector ink in normal vault files; retryable autosaves, conflict recovery copies, and note/folder rename handling.

## Install

See [INSTALL.md](INSTALL.md) for Windows, iPad, and private-repository BRAT setup. The plugin ID is `inkspace`. Runtime files are `main.js`, `manifest.json`, and `styles.css`.

The repository is private. Installing directly through BRAT requires repository access; syncing an installed Windows plugin to iPad through Obsidian Sync is another route. Installing the plugin and syncing note data are separate steps.

## Use

Open a `.md` note in editing / Live Preview mode. The Pencil draws; the keyboard keeps editing. On Windows, enable **Draw with mouse** to use a mouse for ink, or leave it off for normal text selection. **Aa** selects text editing. Import, save, recovery, and PDF commands are in the command palette under **Inkspace**.

The toolbar's **More** menu includes zoom controls, fit width, paper backgrounds, and ink SVG export. To annotate a PDF, run **Inkspace: Annotate current PDF**, or use **Annotate with Inkspace** in its file menu. Typed text remains in your Markdown notes; this version does not add PDF text boxes.

## Positioning and data

Ink attaches to a nearby word or line and follows insertions above that content. Arbitrary freehand marks cannot automatically preserve their meaning through every rewrite, line wrap, fold, theme change, or large layout change. Use the lasso to reposition marks when needed. Ink attached to deleted or ambiguous text is kept and flagged for alignment.

Data lives under `Inkspace Data/<note path>.ink.json`. Include this folder in your vault sync. With Obsidian Sync, enable **Sync all other types** on each device. Conflicting edits keep recovery copies; use **Inkspace: Restore ink from a recovery file**. Keep the same Inkspace version on both devices.

Save failures are reported. If a note reaches a drawing limit, rejected new marks remain in the open editor with an **unsaved** badge; export the ink as SVG before closing that editor. These temporary marks are not synced. See [VALIDATION.md](VALIDATION.md) for capacity limits.

Disabling Inkspace leaves Markdown text intact. Ink needs the plugin to render; SVG exports contain the ink layer, not the full Markdown note. Reading mode and arbitrary third-party views are outside this prototype's drawing surface.

## Goodnotes migration

Export notebooks or folders from Goodnotes as PDF or ZIP, then run **Inkspace: Import Goodnotes PDF or ZIP export**. Existing exported handwriting stays in the PDF background; new Inkspace marks remain editable separately. Original PDFs are preserved. Proprietary `.goodnotes` files, audio links, OCR, and full editable-stroke conversion are not supported by this release.

## Development

Use Node.js 20+ and pnpm. Run `pnpm install`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. `pnpm preview` starts the actual editor extension in a browser test workspace at `http://127.0.0.1:4173`.

`node scripts/browser-test.mjs` tests Edge. Set `INKSPACE_BROWSER=webkit` to test Playwright WebKit after installing it. See [VALIDATION.md](VALIDATION.md) for release checks and device limits. Third-party notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
