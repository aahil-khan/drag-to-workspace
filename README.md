# Edge Toss

Throw a window onto another workspace by dragging it to the screen edge, without opening the overview. GNOME Shell 50.

| You do | What happens |
| --- | --- |
| Drag to the left or right edge and drop straight away | The window goes to the next workspace on that side. You stay here. |
| Hold at the edge | A picker opens with every workspace on that side, nearest first. Move up or down and drop. You stay here. |
| Hold on one workspace in the picker | The card fills up. When it's full it snaps to "Go with it", and dropping takes you there too. |
| Hold Ctrl while dropping | Goes with the window straight away, at any stage. |
| Right-click while still holding the window | Throws right away to the card under the pointer, or to the next workspace if the picker isn't open yet. The screen follows as soon as you let go, whatever the normal drop does. |
| Drag back away from the edge, or press Escape | Nothing is thrown. |

The window arrives where it was before the drag, at the same size, and maximized if it was maximized.

Ctrl is used because GNOME treats Shift as a snap mode during a drag: it clears any pending tile and makes Mutter ignore the button release. Shift does nothing special in Edge Toss. The key can be changed to Alt or turned off.

## Settings

`gnome-extensions prefs edge-toss@aahil-khan.github.com`

- **Area:** a drawing of the screen with the throwing area on each edge. Drag its grips to resize it or the area itself to slide it, or type exact percentages. Each edge can be turned off or set separately. Also sets how close to the edge the pointer has to be, and which monitors take part.
- **Behaviour:** what a normal drop does, how to change it (holding on a card, a key, a right-click), and whether to offer new workspaces.
- **Timing & Look:** how long to hold before the picker opens and before a card fills, with a button that plays both at real speed. Card size, the edge hint, the confirmation label, the throw animation, and reset.

## Sharing the edge with half-tiling

Dropping on the side edge used to half-tile, so the edge is split. By default the top two thirds throw and the rest half-tiles. A thin bar along the edge shows the throwing area as you approach. Change it in the Area settings.

GNOME half-tiles within 48 pixels of the edge. Setting the distance below that gives another way to share: drop near the edge to half-tile, or push all the way to the edge to throw.

Outside the throwing area, GNOME keeps the edge. So it does wherever there is nothing to throw to, for example on the last workspace with static workspaces, or for the only window on a workspace with nothing but a new workspace next to it.

## Edge cases

- **Several monitors:** only outer edges count, because the pointer has to be able to cross between monitors. Edges shared with another monitor still tile. To throw towards a side blocked by a monitor, drag across to that monitor's outer edge. The window goes back to its original monitor.
- **Workspaces on the primary monitor only:** windows on other monitors are on every workspace already, so they can't be thrown.
- **New workspaces:** with dynamic workspaces, each side offers a `+`. On the left it creates a workspace before the first one.
- **Not thrown:** resizes, keyboard moves, windows on all workspaces, and fullscreen windows. A drag that starts with the pointer already at the edge has to leave the edge first.

## Limits

- Workspaces are assumed to run left to right, as they do by default.
- Only tested on GNOME Shell 50.
- Touchscreen drags are untested.

## Install

```sh
make install   # symlinks this repo into ~/.local/share/gnome-shell/extensions
```

On Wayland the shell only finds new extensions at login, so log out and back in, then:

```sh
gnome-extensions enable edge-toss@aahil-khan.github.com
```

## Development

```sh
make test   # drag logic, under node
make e2e    # real drags in a sandboxed headless GNOME Shell
make pack   # zip in dist/
```

`make e2e` runs a throwaway `gnome-shell --headless` with its own home, dconf and session bus, so it doesn't touch the running desktop. A driver extension moves a virtual pointer over real GTK4 windows and checks the results through Mutter. It fails on any JS error in the shell log. Screenshots and logs land in `test/e2e/out/`.

`lib/logic.js` holds the decisions and has no GNOME imports. `extension.js` is the glue, and `lib/ui.js` draws. `extension.js` explains why the tiling conflict is handled by hiding the preview and undoing the tile, rather than by switching `edge-tiling`.
