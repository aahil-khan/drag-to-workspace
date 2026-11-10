<p align="center">
  <img src="docs/logo.svg" width="112" alt="">
</p>

<h1 align="center">Drag to Workspace</h1>

<p align="center">
  Drag a window to the edge of the screen to move it to another workspace.<br>
  No overview, no shortcuts to remember.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/GNOME-46%E2%80%9351-4A86CF?logo=gnome&logoColor=white" alt="GNOME 46 to 51">
  <a href="https://github.com/aahil-khan/drag-to-workspace/releases/latest"><img src="https://img.shields.io/github/v/release/aahil-khan/drag-to-workspace" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/aahil-khan/drag-to-workspace" alt="License"></a>
</p>

<p align="center">
  <img src="docs/demo.gif" width="800" alt="Dragging windows to the screen edge to move them between workspaces">
</p>

## How it works

1. **Drag a window to the left or right edge.** A small tab shows which workspace it will go to.
2. **Let go straight away** to send it to the next workspace. You stay where you are.
3. **Or keep holding**, and a column of every workspace on that side opens. Point at one and let go. Drop on the half nearest the edge to just send the window there, or the inner half to go with it.

That's the whole idea. The window keeps its size and position on the new workspace, and if you change your mind, drag back away from the edge or press Escape.

## More you can do

**While dragging**
- Hold at the **top edge** to see every workspace in one row, on both sides.
- Press **1 to 9** to pick a workspace by number, then drop anywhere.
- Hold **Ctrl** as you drop, or **right-click**, to go with the window.
- Hold **Alt** as you drop to bring the app's other windows along too.

**With more screens**
- Hold at the edge **between two monitors** to open the picker there instead of crossing over.
- Touchscreens work with the same gestures.

**Made to fit in**
- Half-screen tiling keeps working on the parts of the edge you don't use.
- An optional **Undo / Go** popup after each move.
- Workspace names and app icons on the previews.
- A list of apps to leave alone.

## Install

Coming soon to [extensions.gnome.org](https://extensions.gnome.org). Until then, install it from a release:

1. Download the zip that matches your GNOME version (`gnome-shell --version`) from the [latest release](https://github.com/aahil-khan/drag-to-workspace/releases/latest):

   | GNOME | Zip |
   |---|---|
   | 49, 50, 51 | `drag-to-workspace-gnome-49-51.zip` |
   | 47, 48 | `drag-to-workspace-gnome-47-48.zip` |
   | 46 | `drag-to-workspace-gnome-46.zip` |

2. Install it, then log out and back in:

   ```sh
   gnome-extensions install --force drag-to-workspace-gnome-49-51.zip
   ```

3. Turn it on:

   ```sh
   gnome-extensions enable drag-to-workspace@aahil-khan.github.com
   ```

Tested on Ubuntu 24.04 and 26.04, Debian 13, Fedora 41 to 45, and AlmaLinux 10.

## Settings

Open them from the Extensions app, or with `gnome-extensions prefs drag-to-workspace@aahil-khan.github.com`.

- **Zones:** which part of each edge moves windows, how close you need to get, and which monitors and edges are used.
- **Behaviour:** whether a drop keeps you where you are, the ways to do the opposite, number keys, and the key for moving an app's windows together.
- **Look & Feel:** timings, preview size, names and icons, the edge highlight, animation, and the popup after a move.
- **Apps:** apps whose windows are never moved.

## FAQ

**Does it get in the way of half-screen tiling?**<br>
No. By default only the top two thirds of each side edge move windows, and the rest tiles as usual. You can move or resize that part in **Zones**, or lower **Distance from Edge** so a window tiles near the edge and only moves when pushed right up against it.

**I'd rather always go with the window.**<br>
Set **When You Drop a Window** to **Go With the Window** in **Behaviour**. The two halves of each workspace in the picker swap round to match.

**I don't want to aim at half a workspace.**<br>
In **Behaviour**, set **In the Workspace Picker** to **Hold**. Holding over a workspace then fills it up, and letting go after that goes with the window.

**Why don't the top edge and the edges between monitors react straight away?**<br>
GNOME uses them for maximizing and moving between screens, so they need a longer hold, and only move a window once you've pointed at a workspace. Let go without choosing and GNOME does what it normally would.

**Why won't some windows move?**<br>
Fullscreen windows and windows set to show on every workspace stay put. So do windows on a second monitor when workspaces are set to the primary display only, since those are already on every workspace.

**Does it work with vertical workspaces?**<br>
Yes. The left edge moves windows up and the right edge moves them down. Grids of workspaces are treated as one long row.

## Contributing

Translations are welcome: start from `po/drag-to-workspace.pot`, save it as `po/<language>.po`, and open a pull request.

<details>
<summary>Building and testing</summary>

<br>

```sh
make test     # the drag logic, under node
make e2e      # real drags in a sandboxed headless GNOME Shell, on your own version
make install  # symlinks this checkout into your extensions folder (GNOME 49 or newer)
make pack     # builds the zips into dist/
make matrix   # tests each zip on the distros it targets, in containers with podman
make pot      # regenerates the translation template
```

`make e2e` runs a throwaway `gnome-shell --headless` with its own home, dconf and session bus, so it doesn't touch your running desktop. A driver extension moves a virtual pointer over real GTK4 windows and checks the results through Mutter. Any JS error in the shell log fails the run.

- `lib/logic.js` makes the decisions and has no GNOME imports.
- `extension.js` connects it to the shell.
- `lib/ui.js` draws during a drag, with `lib/workspaceCard.js` for each workspace and `lib/movedPopup.js` for the popup afterwards.
- `prefs.js` is the settings window, and the files in `prefs/` are its parts.

There's no version checking at runtime. `scripts/pack.sh` builds one zip per range of versions, swapping in `compat/pre49` for the older maximize API on 47 and 48, and also `compat/46` on 46, which has no accent colour.

</details>

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
