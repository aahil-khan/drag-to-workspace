# Edge Toss

Move windows to other workspaces by dragging them to the edge of the screen, without opening the overview.

## How it works

| While dragging a window | What happens |
| --- | --- |
| Drop it at the left or right edge | It moves to the next workspace on that side. You stay where you are. |
| Hold it at the edge | A picker opens with every workspace on that side. Move up or down and drop. |
| Hold over a workspace in the picker | The preview fills up. Drop after that to go with the window. |
| Hold Ctrl as you drop | Goes with the window straight away. |
| Right-click | Moves the window right away, and takes you with it when you let go. |
| Drag back away from the edge, or press Escape | Nothing moves. |

The window keeps its position and size on the new workspace, and stays maximized if it was maximized.

A window can't be moved while it's fullscreen or set to appear on all workspaces. Resizing a window into the edge does nothing.

## Window tiling

Dropping a window on a side of the screen normally tiles it to half the screen. Edge Toss only uses part of each edge, the top two thirds by default, and normal tiling keeps working everywhere else. A thin bar shows the zone as a window gets close.

You can resize or move the zones in the settings, or use only one edge. Another way to share an edge is to lower **Distance from Edge**: windows then tile near the edge and move when pushed right up to it.

## Multiple monitors

Only the outer edges of your screens are used, so windows can still cross between monitors, and edges between monitors keep normal tiling. To move a window towards a side blocked by another monitor, drag it to that monitor's far edge. The window stays on its original monitor.

If workspaces are set to the primary display only, windows on other displays are already on every workspace, so they can't be moved.

## Settings

Open them from the Extensions app, or run:

```sh
gnome-extensions prefs edge-toss@aahil-khan.github.com
```

- **Zones:** where on each edge windows move, how close the pointer has to be, and which monitors are used.
- **Behaviour:** whether a drop keeps you on the current workspace, and the ways to do the opposite.
- **Timing & Look:** the two hold delays, with a preview, plus preview size, the zone highlight, the destination label, and animation.

## Limitations

- Workspaces are assumed to run left to right, the default since GNOME 40.
- Touchscreen drags haven't been tested.

## Development

```sh
make test     # the drag logic, under node
make e2e      # real drags in a sandboxed headless GNOME Shell, on your own version
make install  # symlinks this checkout into your extensions folder
make pack     # builds the zips for extensions.gnome.org into dist/
make matrix   # tests each zip on the distros it targets, in containers with podman
```

`make e2e` runs a throwaway `gnome-shell --headless` with its own home, dconf and session bus, so it doesn't touch your running desktop. A driver extension moves a virtual pointer over real GTK4 windows and checks the results through Mutter. Any JS error in the shell log fails the run. Screenshots and logs land in `test/e2e/out/`.

### Layout

- `lib/logic.js` makes the decisions and has no GNOME imports.
- `extension.js` connects it to the shell, and `lib/ui.js` draws.
- `prefs.js` is the settings window.

### Versions

There's no version checking at runtime. Each range of versions gets its own zip, built by `scripts/pack.sh`, with only the code that range runs:

| Zip | Versions | Differs by |
| --- | --- | --- |
| `edge-toss-gnome-49-51.zip` | 49, 50, 51 | This checkout as it is |
| `edge-toss-gnome-47-48.zip` | 47, 48 | `compat/pre49`, the older maximize API |
| `edge-toss-gnome-46.zip` | 46 | Also `compat/46`, as there's no accent colour |

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
