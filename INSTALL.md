# Install Inkspace 0.1.0

This is an early prototype. Start with a test note or a copy of your vault. Physical iPad writing quality is not yet verified.

## Windows

1. Download `inkspace-0.1.0.zip` from this repository's release.
2. Extract its `inkspace` folder into `<your vault>/.obsidian/plugins/`.
3. Confirm the result is `.obsidian/plugins/inkspace/main.js`, alongside `manifest.json` and `styles.css`.
4. Restart Obsidian. In **Settings → Community plugins**, enable **Inkspace**.
5. Open a Markdown note in editing / Live Preview mode. Use a pen display, or enable the toolbar's **Draw with mouse** button.

If your vault uses a custom configuration folder, use that folder in place of `.obsidian`.

## iPad through Obsidian Sync

If the Windows and iPad vaults already use Obsidian Sync:

1. Install Inkspace on Windows as above.
2. On both devices, enable **Installed community plugins** and **Active community plugin list** under Sync's vault configuration settings. Enable **Community plugin settings** if you want the same tool preferences.
3. Enable **Sync all other types** on both devices, and include `Inkspace Data` in the synced folders.
4. Allow sync to finish, restart Obsidian on iPad, and enable Inkspace if necessary.

Plugin files, enablement, and note-data syncing are separate settings. An Obsidian Sync subscription is required for this route.

## iPad or Windows through BRAT

1. In **Settings → Community plugins → Browse**, install and enable **BRAT**.
2. This repository is private. In BRAT settings, configure a GitHub token with **Contents: read-only** access to **mae0212/obsidian-inkspace**. Follow BRAT's [private repository guide](https://tfthacker.com/brat-private-repo).
3. Run **BRAT: Add a beta plugin for testing**. Enter `mae0212/obsidian-inkspace`, select version `0.1.0` if prompted, and install.
4. Enable **Inkspace** under Community plugins.

The token belongs in BRAT's configuration. Public-repository installation would avoid this requirement, but this repository remains private.

## First use on iPad

- Use a current Obsidian release; the declared minimum is 1.8.7. Recent iPadOS is recommended for modern pen sampling and document zoom.
- Open a `.md` note in editing / Live Preview mode. Start with a few typed lines and annotate them.
- If Scribble intercepts strokes or scratch-out gestures, disable it in **iPad Settings → Apple Pencil**.
- One finger scrolls. Two fingers pinch the note. The More menu offers **Fit writing width**, zoom, and paper backgrounds.
- Choose **Aa** to place the caret or select text; choose a drawing tool to resume ink. A hardware keyboard can continue typing while Pen is active.
- Test normal palm resting, fast handwriting, short dots, and repeated pen lifts. These hardware behaviors remain a required device check.

## Keep data together

Sync `.md` notes, source PDFs, and **Inkspace Data**. With Obsidian Sync, turn on **Sync all other types**. Plugin installation alone does not sync annotations.

Major text/layout changes may require lasso repositioning. Keep the same writing width on both devices; use zoom to fit a smaller screen. Ink undo/redo uses the toolbar. Keyboard text undo remains with Obsidian.

## Remove

Disable Inkspace in Community plugins. Markdown and original PDFs remain intact. Keep `Inkspace Data` to retain annotations for re-enabling the plugin. Exported annotated PDFs work in other PDF viewers.
