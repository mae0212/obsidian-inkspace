# Install or update Inkspace 0.2.0

This is an early prototype. Start with a test note. Keep the same plugin version on iPad and Windows.

## iPad or Windows through BRAT

1. In **Settings → Community plugins → Browse**, install and enable **BRAT**.
2. Open BRAT settings and choose **Add beta plugin**.
3. Enter `mae0212/obsidian-inkspace`, select version **0.2.0**, and install.
4. Enable **Inkspace** under **Settings → Community plugins**.

The repository is public; a GitHub personal access token is not needed for normal installation.

### Update from 0.1.0

In BRAT, check for updates. If the Inkspace entry is pinned to **0.1.0**, change its selected version to **0.2.0** and update it. Restart Obsidian after the update. Check the installed Inkspace version under Community plugins.

Your existing ink files and notes use the same format. Keep the `Inkspace Data` folder.

## Manual Windows installation or update

1. Download **inkspace-0.2.0.zip** from the [release page](https://github.com/mae0212/obsidian-inkspace/releases/tag/0.2.0).
2. Close Obsidian.
3. Extract the ZIP's `inkspace` folder into `<your vault>/.obsidian/plugins/`. For an update, replace the runtime files in the existing `inkspace` folder.
4. Confirm `.obsidian/plugins/inkspace/main.js`, `manifest.json`, and `styles.css` exist.
5. Reopen Obsidian and enable **Inkspace** under **Settings → Community plugins** if necessary.

Preserve `data.json` in the existing plugin folder to keep your tool settings. Keep `Inkspace Data` to retain annotations. If your vault uses a custom configuration folder, use it instead of `.obsidian`.

For manual iPad installation, a file manager that exposes hidden folders, such as Taio, can place the same `inkspace` folder in the iPad vault's `.obsidian/plugins/` folder. Obsidian documents [accessing the configuration folder on iPad](https://help.obsidian.md/configuration-folder). BRAT avoids this file-management step.

## iPad through Obsidian Sync

If Windows and iPad already use Obsidian Sync:

1. Install or update Inkspace on Windows.
2. On both devices, enable **Installed community plugins** and **Active community plugin list** under Sync's vault configuration settings. Enable **Community plugin settings** if you want the same tool preferences and saved styles.
3. Enable **Sync all other types** on both devices, and include `Inkspace Data` in the synced folders.
4. Allow sync to finish, restart Obsidian on iPad, and confirm the installed version is **0.2.0**.

Plugin files, enablement, and note-data syncing are separate settings. This route requires an Obsidian Sync subscription. Use one sync provider for a vault.

## First use on iPad

- Open a `.md` note in editing / Live Preview mode. Type a few lines, then annotate them.
- Tap the size button in the toolbar. Use thickness presets or **− / +**, or type an exact size. Pen, highlighter, and eraser sizes are remembered separately.
- In the saved styles, apply a style to recall its tool, color, and thickness. Use its save control to replace it with the current pen or highlighter style.
- Choose **More → Add writing space below** to add eight blank lines below the current line. Normal text undo reverses this insertion.
- One finger scrolls the note; two fingers pinch it. **More** includes zoom, fit width, and paper backgrounds.
- Choose **Aa** to place the caret or select text; choose a drawing tool to resume ink. A hardware keyboard can continue typing while Pen is active.
- If Scribble intercepts strokes or scratch-out gestures, disable it in **iPad Settings → Apple Pencil**.

The thickness-control update removes the need for horizontal dragging and includes browser gesture-isolation checks. Verify the sidebar interaction on your physical iPad after updating. Pencil latency, palm resting, fast strokes, and cross-device sync also need real-device checks.

## Keep your notes together

Sync Markdown notes, source PDFs, and **Inkspace Data**. With Obsidian Sync, enable **Sync all other types**. Plugin installation alone does not sync annotations.

Major text or layout changes may require lasso repositioning. Keep the same writing width across devices and use zoom to fit a smaller screen. Toolbar undo/redo handles ink; normal keyboard undo handles text, including added writing space.

Disabling Inkspace leaves Markdown and original PDFs intact. Keep `Inkspace Data` to render the annotations again when re-enabling it. Exported annotated PDFs work in other PDF viewers.
