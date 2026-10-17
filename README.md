# Inkspace for Obsidian

A planned Obsidian plugin for typing and handwriting on the same note surface, with Apple Pencil input on iPad and note compatibility on Windows.

**Status: planning and prototype stage.** This repository does not yet contain an implemented plugin, installable package, or release. The capabilities below are design goals, not completed features.

## Intended experience

Draw directly over existing, editable Markdown notes: circle typed words, highlight sentences, draw arrows across paragraphs, and add handwritten explanations beside text and images. Ink should remain visible while typing, without entering a separate drawing block or notebook.

Planned tools include colored pens, adjustable stroke widths, translucent highlighters, erasers, undo/redo, and lasso selection. The interaction will target Pencil drawing with finger scrolling and zooming on iPad, while preserving ordinary keyboard editing on both platforms.

## Design and validation

- Use Obsidian's editor extension system and mobile-compatible web APIs. Native PencilKit integration is not assumed.
- Store editable ink in portable sidecar files alongside Markdown notes in the vault. Both devices will need those files included in their vault sync configuration. The storage format is not finalized.
- Associate annotations with relevant content and investigate a consistent writing width across devices. Text edits, font changes, rotation, and line wrapping can change layout; reliable anchoring must be demonstrated, and some marks may need manual repositioning after substantial reflow.
- Treat real-device testing as a release gate. Palm rejection, stroke latency, fast handwriting, keyboard/Pencil switching, scrolling, reopening notes, and transferring notes between iPad and Windows must be checked on actual hardware. Goodnotes-equivalent smoothness is not yet established.

## Installation plan

The intended distribution is a GitHub release installable through BRAT on iPad and Windows. **There is nothing to install yet.** Installation instructions will be published with the first tested prototype. Installing from a private GitHub repository through BRAT requires an appropriate GitHub token.

## Goodnotes migration

Importing exported Goodnotes PDFs is a later milestone, after the core writing experience works. Full-fidelity conversion of proprietary `.goodnotes` files, including all editable strokes and features, is not promised.
