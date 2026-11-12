<p align="center">
  <img src="docs/logo.svg" width="120" alt="">
</p>

<h1 align="center">Drag to Workspace</h1>

<p align="center">
  <b>Drag a window to the edge of the screen to move it to another workspace.</b><br>
  No overview, no shortcuts to remember, and half-screen tiling keeps working.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/GNOME-46%E2%80%9351-3584E4?style=flat-square&logo=gnome&logoColor=white" alt="GNOME 46 to 51">
  <a href="https://github.com/aahil-khan/drag-to-workspace/releases/latest"><img src="https://img.shields.io/github/v/release/aahil-khan/drag-to-workspace?style=flat-square&color=3584E4" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/Wayland-ready-3584E4?style=flat-square" alt="Wayland ready">
  <img src="https://img.shields.io/badge/touchscreen-supported-3584E4?style=flat-square" alt="Touchscreen supported">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/aahil-khan/drag-to-workspace?style=flat-square&color=3584E4" alt="License"></a>
</p>

<p align="center">
  <img src="docs/demo.gif" width="820" alt="Dragging windows to the screen edge to move them between workspaces">
</p>

## Contents

- [How it works](#how-it-works)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Settings](#settings)
- [FAQ](#faq)
- [Uninstalling](#uninstalling)
- [Contributing](#contributing)
- [License](#license)

## How it works

1. **Drag a window to the left or right edge.** A small tab shows which workspace it will go to.
2. **Let go straight away** to send it to the next workspace. You stay where you are.
3. **Or keep holding**, and a column of every workspace on that side opens, with live previews. Point at one and let go. Drop on the half nearest the edge to just send the window there, or the inner half to go with it.

The window keeps its position and size on the new workspace, and stays maximized if it was maximized. Change your mind? Drag back away from the edge or press Escape, and nothing moves.

## Features

### ✋ While dragging

| Do this | And this happens |
|---|---|
| Drop at the left or right edge | The window moves to the next workspace on that side |
| Hold at the edge | A picker shows every workspace on that side, with live previews |
| Drop on the outer half of a workspace in the picker | The window moves there, and you stay where you are |
| Drop on the inner half | The window moves there, and you go with it |
| Hold at the top edge | Every workspace in one row, on both sides. A quick drop still maximizes. |
| Press 1 to 9 | Chooses that workspace, so you can drop anywhere. Press it again to cancel. |
| Hold Ctrl as you drop, or right-click | Goes with the window, wherever you drop |
| Hold Alt as you drop | Brings the app's other windows on the workspace along too |

### 🖥️ Screens and devices

| | |
|---|---|
| **Multiple monitors** | Hold at the edge between two monitors to open the picker there, without crossing over |
| **Touchscreens** | The same gestures work with your finger |
| **Vertical workspaces** | The arrows point up and down when your workspaces are stacked |

### 🧩 Fits into GNOME

| | |
|---|---|
| **Keeps tiling working** | Choose which part of each edge moves windows. Half-screen tiling works everywhere else. |
| **Undo and Go** | An optional popup after a move, to undo it or go there |
| **Names and icons** | Workspace names and app icons on the previews |
| **Excluded apps** | Pick apps whose windows are never moved |
| **Follows your style** | Uses your accent colour, and respects GNOME's reduced animation setting |
| **Translatable** | Every bit of text can be translated |

## Requirements

- **GNOME Shell 46 to 51**, on Wayland or X11. Check with `gnome-shell --version`.
- `curl` or `wget`, and `unzip`, which most systems have. Install it as yourself, not with `sudo`.

Every version is tested on real distro builds: Ubuntu 24.04 and 26.04, Debian 13, Fedora 41 to 45, and AlmaLinux 10.

## Installation

1. Run this in a terminal:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/aahil-khan/drag-to-workspace/main/get.sh | bash
   ```

2. **Log out and back in.** GNOME Shell on Wayland only loads a new extension at login. On GNOME 46 to 48 with X11, press Alt+F2, type `r` and press Enter instead.

That's all. The script picks the zip for your GNOME version from the latest release, checks it, installs it for your user only and turns it on. Run the same command again to update; your settings stay as you set them.

> [!NOTE]
> **GNOME Extensions:** under review on [extensions.gnome.org](https://extensions.gnome.org).

### Other ways to install

**From a release zip.** Download the zip for your GNOME version from the [latest release](https://github.com/aahil-khan/drag-to-workspace/releases/latest):

| GNOME | Zip |
|---|---|
| 49, 50, 51 | `drag-to-workspace-gnome-49-51.zip` |
| 47, 48 | `drag-to-workspace-gnome-47-48.zip` |
| 46 | `drag-to-workspace-gnome-46.zip` |

```sh
gnome-extensions install --force drag-to-workspace-gnome-49-51.zip
# Log out and back in, then:
gnome-extensions enable drag-to-workspace@aahil-khan.github.com
```

<details>
<summary><b>From source</b></summary>

<br>

```sh
git clone https://github.com/aahil-khan/drag-to-workspace.git
cd drag-to-workspace
make install
```

This links the checkout into your extensions folder, for GNOME 49 or newer. On older versions, run `make pack` and install the zip it builds in `dist/` instead. Then log out, log back in, and enable it as above.

</details>

## Settings

Open them from the Extensions app, or run:

```sh
gnome-extensions prefs drag-to-workspace@aahil-khan.github.com
```

| Tab | What you can change |
|---|---|
| **Zones** | Which part of each edge moves windows, how close the pointer has to be, which monitors are used, and the top edge and the edges between monitors |
| **Behaviour** | Whether a drop keeps you on the current workspace, the ways to do the opposite, number keys, and the key for moving an app's windows together |
| **Look & Feel** | How long to hold before the picker opens, preview size, workspace names, app icons, the edge highlight, animation, and the popup after a move |
| **Apps** | Apps whose windows are never moved |

## FAQ

**Does it get in the way of half-screen tiling?**<br>
No. By default only the top two thirds of each side edge move windows, and the bottom third tiles as usual. You can move or resize that part in **Zones**, or lower **Distance from Edge** so that a window tiles near the edge and only moves when pushed right up against it.

**I'd rather always go with the window.**<br>
Set **When You Drop a Window** to **Go With the Window** in **Behaviour**. The two halves of each workspace in the picker swap round to match.

**I don't want to aim at half a workspace.**<br>
In **Behaviour**, set **In the Workspace Picker** to **Hold**. Holding over a workspace then fills it up, and letting go after that goes with the window.

**Why don't the top edge and the edges between monitors react straight away?**<br>
GNOME uses them for maximizing and moving between screens, so they need a longer hold, and only move a window once you've pointed at a workspace. Let go without choosing and GNOME does what it normally would.

**Why won't some windows move?**<br>
Fullscreen windows and windows set to show on every workspace stay put. So do windows on a second monitor when workspaces are set to the primary display only, since those are already on every workspace.

**What about grids of workspaces?**<br>
They're treated as one long row: the left edge goes to earlier workspaces and the right edge to later ones.

## Uninstalling

```sh
gnome-extensions uninstall drag-to-workspace@aahil-khan.github.com
```

Or remove it from the Extensions app. Its settings stay in dconf in case you come back; to clear them too:

```sh
dconf reset -f /org/gnome/shell/extensions/drag-to-workspace/
```

## Contributing

**Translations** are welcome. Start from `po/drag-to-workspace.pot`, save it as `po/<language>.po`, and open a pull request.

**Bugs and ideas** go in the [issue tracker](https://github.com/aahil-khan/drag-to-workspace/issues). Please include your GNOME version and distro.

### Building and testing

```sh
make test     # the drag logic, under node
make e2e      # real drags in a sandboxed headless GNOME Shell, on your own version
make install  # symlinks this checkout into your extensions folder
make pack     # builds the zips for extensions.gnome.org into dist/
make matrix   # tests each zip on the distros it targets, in containers with podman
make pot      # regenerates the translation template
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
