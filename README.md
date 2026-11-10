<div align="center">

<img src="docs/logo.svg" width="128" height="128" alt="Drag to Workspace icon">

# Drag to Workspace

**Throw windows between workspaces.**<br>
Drag a window to the edge of the screen to move it to another workspace, without opening the overview.

<p>
  <img alt="GNOME Shell 46 to 51" src="https://img.shields.io/badge/GNOME_Shell-46--51-4A86CF?style=for-the-badge&logo=gnome&logoColor=white&labelColor=2B2B2B">
  <a href="https://github.com/aahil-khan/drag-to-workspace/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/aahil-khan/drag-to-workspace?style=for-the-badge&color=3584E4&labelColor=2B2B2B"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/aahil-khan/drag-to-workspace?style=for-the-badge&color=7E57C2&labelColor=2B2B2B"></a>
  <a href="https://github.com/aahil-khan/drag-to-workspace/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/aahil-khan/drag-to-workspace?style=for-the-badge&logo=github&color=FFB300&labelColor=2B2B2B"></a>
</p>

<p>
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#supported-gnome-versions">Supported Versions</a> •
  <a href="#tips">Tips</a> •
  <a href="#known-issues">Known Issues</a> •
  <a href="#contributing">Contributing</a>
</p>

<img src="docs/demo.gif" width="800" alt="Dragging windows to the screen edge to move them between workspaces">

</div>

---

## Features

| | Feature | |
|:-:|---|---|
| ➡️ | **Drop at the edge** | Drop a window at the left or right edge to move it to the next workspace on that side. You stay where you are. |
| 🗂️ | **Workspace picker** | Hold at the edge to see every workspace on that side, with live previews, then drop on the one you want |
| 🚶 | **Stay or go with it** | In the picker, drop on the outer half of a workspace to just send the window, or the inner half to go with it. Ctrl or a right-click also take you along. |
| ⬆️ | **Top edge** | Hold at the top edge for every workspace in one row. A quick drop there still maximizes. |
| 🖥️ | **Multiple monitors** | Hold at the edge between two monitors to open the picker there, without crossing over |
| 🔢 | **Number keys** | Press 1 to 9 while dragging to choose a workspace, then drop anywhere |
| 🪟 | **All of an app's windows** | Hold Alt as you drop to bring the app's other windows on the workspace too |
| ↩️ | **Undo and Go** | An optional popup after a move, to undo it or go there |
| 👆 | **Touchscreens** | The same gestures work with your finger |
| 🧩 | **Plays nice with tiling** | Choose which part of each edge moves windows. Half-screen tiling keeps working everywhere else. |
| 🚫 | **Excluded apps** | Pick apps whose windows are never moved |
| 🏷️ | **Names and icons** | Workspace names and app icons on the previews |
| 🌍 | **Translatable** | Every bit of text can be translated |

The window keeps its position and size on the new workspace, and stays maximized if it was maximized. Drag back away from the edge or press Escape, and nothing moves.

## Installation

### From GNOME Extensions (recommended)

Coming soon to [extensions.gnome.org](https://extensions.gnome.org).

### From a release

**1. Download the zip for your GNOME version** from the [latest release](https://github.com/aahil-khan/drag-to-workspace/releases/latest). Check your version with `gnome-shell --version`.

**2. Install it**

```bash
gnome-extensions install --force drag-to-workspace-gnome-49-51.zip
```

**3. Log out and back in, then enable the extension**

```bash
gnome-extensions enable drag-to-workspace@aahil-khan.github.com
```

**4. Drag a window to the edge of the screen** 🎉

### From source

```bash
git clone https://github.com/aahil-khan/drag-to-workspace.git
cd drag-to-workspace
make install
```

This links the checkout into your extensions folder, for GNOME 49 or newer. On older versions, run `make pack` and install the zip it builds in `dist/` instead. Then log out, log back in, and enable it as above.

## Supported GNOME Versions

| GNOME | Download |
|---|---|
| 49, 50, 51 | `drag-to-workspace-gnome-49-51.zip` |
| 47, 48 | `drag-to-workspace-gnome-47-48.zip` |
| 46 | `drag-to-workspace-gnome-46.zip` |

Tested on real distro builds: Ubuntu 24.04 and 26.04, Debian 13, Fedora 41 to 45, and AlmaLinux 10.

## Settings

Open them from the Extensions app, or run:

```bash
gnome-extensions prefs drag-to-workspace@aahil-khan.github.com
```

| Tab | What's there |
|---|---|
| **Zones** | Where on each edge windows move, how close the pointer has to be, which monitors are used, and the top edge and the edges between monitors |
| **Behaviour** | Whether a drop keeps you on the current workspace, the ways to do the opposite, number keys, and the key for moving all of an app's windows |
| **Look & Feel** | How long to hold before the picker opens, preview size, workspace names, app icons, the zone highlight, animation, and the popup after a move |
| **Apps** | Apps whose windows are never moved |

## Tips

**Keep half-screen tiling**<br>
By default only the top two thirds of each side edge move windows, and the bottom third still tiles. Change the split in **Zones**, or lower **Distance from Edge** so that windows tile near the edge and move when pushed right up to it.

**Prefer to go with the window?**<br>
Set **When You Drop a Window** to **Go With the Window** in **Behaviour**. The picker then works the other way round.

**Rather hold than aim?**<br>
In **Behaviour**, set **In the Workspace Picker** to **Hold**. Holding over a workspace then fills it up, and dropping after that goes with the window.

**The top edge and the edges between monitors** take a longer hold, and a drop there only moves the window once you've moved onto a workspace. Drop without choosing, and GNOME maximizes or crosses as usual.

## Known Issues

- With workspaces on the primary display only, windows on other displays are already on every workspace, so they can't be moved.
- With vertical workspace layouts, the left edge moves windows up and the right edge moves them down. Grids of workspaces are treated as one long row.
- Fullscreen windows and windows set to appear on all workspaces aren't moved.

## Contributing

### Translations

Translations are welcome. Start from `po/drag-to-workspace.pot`, save it as `po/<language>.po`, and open a pull request.

### Development

```bash
make test     # the drag logic, under node
make e2e      # real drags in a sandboxed headless GNOME Shell, on your own version
make install  # symlinks this checkout into your extensions folder
make pack     # builds the zips for extensions.gnome.org into dist/
make matrix   # tests each zip on the distros it targets, in containers with podman
make pot      # regenerates the translation template, po/drag-to-workspace.pot
```

<details>
<summary>How it's put together</summary>

<br>

`make e2e` runs a throwaway `gnome-shell --headless` with its own home, dconf and session bus, so it doesn't touch your running desktop. A driver extension moves a virtual pointer over real GTK4 windows and checks the results through Mutter. Any JS error in the shell log fails the run. Screenshots and logs land in `test/e2e/out/`.

- `lib/logic.js` makes the decisions and has no GNOME imports.
- `extension.js` connects it to the shell.
- `lib/ui.js` draws during a drag, with `lib/workspaceCard.js` for each workspace and `lib/movedPopup.js` for the popup afterwards.
- `prefs.js` is the settings window, and the files in `prefs/` are its parts.

There's no version checking at runtime. Each range of versions gets its own zip, built by `scripts/pack.sh`, with only the code that range runs:

| Zip | Versions | Differs by |
|---|---|---|
| `drag-to-workspace-gnome-49-51.zip` | 49, 50, 51 | This checkout as it is |
| `drag-to-workspace-gnome-47-48.zip` | 47, 48 | `compat/pre49`, the older maximize API |
| `drag-to-workspace-gnome-46.zip` | 46 | Also `compat/46`, as there's no accent colour |

`make pack` compiles any translations in `po/` into the zips.

</details>

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
