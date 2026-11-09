// Edge Toss: drag a window to a screen edge to throw it onto another workspace.
//
// Sharing the edge with GNOME's half-tiling: Mutter decides to tile from the
// pointer position during the drag, and nothing exposes a way to veto it. Flipping
// org.gnome.mutter edge-tiling mid-drag does not work, because Mutter keeps the
// tile mode it already chose once the setting goes off (meta-window-drag.c), and a
// crash would leave the setting off for good. So while Edge Toss owns the pointer
// it hides the tile preview, lets Mutter tile on release if it wants to, and undoes
// that before the next frame as it moves the window away.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {TilePreview} from 'resource:///org/gnome/shell/ui/windowManager.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {computeTargets, DragSession, Phase} from './lib/logic.js';
import {Overlay} from './lib/ui.js';

const POLL_MS = 16;

// DRAG_THRESHOLD_TO_SHAKE_THRESHOLD_FACTOR in meta-window-drag.c
const MUTTER_TILE_BAND_FACTOR = 6;

const MOVABLE_TYPES = new Set([
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
]);

const ANY_BUTTON = Clutter.ModifierType.BUTTON1_MASK |
    Clutter.ModifierType.BUTTON2_MASK |
    Clutter.ModifierType.BUTTON3_MASK;

function isMouseMove(op) {
    return op === Meta.GrabOp.MOVING || op === Meta.GrabOp.MOVING_UNCONSTRAINED;
}

function canToss(win) {
    return win &&
        MOVABLE_TYPES.has(win.get_window_type()) &&
        win.allows_move() &&
        !win.is_fullscreen() &&
        !win.is_on_all_workspaces();
}

function countsOnWorkspace(win) {
    return !win.is_on_all_workspaces() && !win.is_skip_taskbar();
}

function snapshotMonitors() {
    return Main.layoutManager.monitors.map(m => ({
        index: m.index,
        x: m.x,
        y: m.y,
        width: m.width,
        height: m.height,
        workArea: Main.layoutManager.getWorkAreaForMonitor(m.index),
    }));
}

export default class EdgeTossExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._overlay = new Overlay(this._settings);
        this._drag = null;

        // Hide Mutter's tile preview while the pointer belongs to Edge Toss.
        const self = this;
        this._injections = new InjectionManager();
        this._injections.overrideMethod(TilePreview.prototype, 'open', original => function (...args) {
            if (self._drag && self._drag.session.phase !== Phase.IDLE)
                return;
            original.apply(this, args);
        });

        const manager = global.workspace_manager;
        this._signals = [
            [global.display, global.display.connect('grab-op-begin', (_d, win, op) => this._onGrabBegin(win, op))],
            [global.display, global.display.connect('grab-op-end', (_d, win, op) => this._onGrabEnd(win, op))],
            [manager, manager.connect('notify::n-workspaces', () => this._drag?.session.invalidate())],
            [manager, manager.connect('active-workspace-changed', () => this._drag?.session.invalidate())],
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._cancelDrag())],
        ];
    }

    disable() {
        this._cancelDrag();
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = null;
        this._injections.clear();
        this._injections = null;
        this._overlay.destroy();
        this._overlay = null;
        this._settings = null;
    }

    _onGrabBegin(win, op) {
        this._cancelDrag();
        if (!isMouseMove(op) || !canToss(win) || Main.overview.visible)
            return;

        const monitors = snapshotMonitors();
        const originMonitor = monitors[win.get_monitor()] ?? monitors[0];
        if (!originMonitor)
            return;

        this._drag = {
            window: win,
            monitors,
            originMonitor,
            frameRect: win.get_frame_rect(),
            wasMaximized: win.is_maximized(),
            session: new DragSession({
                getTargets: side => this._targetsFor(win, side),
                band: Meta.prefs_get_drag_threshold() * MUTTER_TILE_BAND_FACTOR,
                aspect: originMonitor.width / originMonitor.height,
                tileZone: this._settings.get_string('tile-zone'),
                tileZoneSize: this._settings.get_int('tile-zone-size'),
                holdDelay: this._settings.get_int('hold-delay-ms'),
                followDelay: this._settings.get_int('follow-delay-ms'),
                dropAction: this._settings.get_string('drop-action'),
            }),
        };

        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        GLib.Source.set_name_by_id(this._pollId, '[edge-toss] drag poll');
        this._tick();
    }

    _targetsFor(win, side) {
        const manager = global.workspace_manager;
        const workspace = win.get_workspace();
        const count = manager.get_n_workspaces();
        const last = manager.get_workspace_by_index(count - 1);

        const others = workspace.list_windows()
            .filter(w => w !== win && w.get_transient_for() !== win && countsOnWorkspace(w));

        return computeTargets({
            activeIndex: workspace.index(),
            count,
            side,
            dynamic: Meta.prefs_get_dynamic_workspaces(),
            lastIsEmpty: !last.list_windows().some(countsOnWorkspace),
            windowAlone: others.length === 0,
        });
    }

    _tick() {
        const drag = this._drag;
        if (!drag)
            return;

        const [x, y] = global.get_pointer();
        const wasIdle = drag.session.phase === Phase.IDLE;
        drag.session.update(x, y, GLib.get_monotonic_time() / 1000, drag.monitors);

        // The preview may already be up if Mutter got there before us.
        if (wasIdle && drag.session.phase !== Phase.IDLE)
            Main.wm._hideTilePreview();

        this._overlay.render(drag.session, {
            monitors: drag.monitors,
            originMonitor: drag.originMonitor,
            draggedWindow: drag.window,
            targetWorkspace: target => (target.index >= 0
                ? global.workspace_manager.get_workspace_by_index(target.index)
                : null),
        });
    }

    _stopPolling() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }

    _cancelDrag() {
        this._stopPolling();
        this._drag = null;
        this._overlay?.clear();
    }

    _onGrabEnd(win, op) {
        const drag = this._drag;
        if (!drag || drag.window !== win || !isMouseMove(op))
            return;

        this._tick();
        const [, y, mods] = global.get_pointer();
        // Escape ends the grab with the button still held. Mutter has already put
        // the window back, so there is nothing to throw.
        const cancelled = (mods & ANY_BUTTON) !== 0;
        const shift = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const decision = cancelled ? null : drag.session.decide(shift);
        const side = drag.session.side;
        const monitor = drag.monitors[drag.session.monitorIndex];

        this._cancelDrag();
        if (!decision)
            return;

        const snapshot = decision.follow ? null : this._snapshotWindow(win);
        const laters = global.compositor.get_laters();
        laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._toss(win, drag, decision, {snapshot, side, monitor, y});
            return GLib.SOURCE_REMOVE;
        });
    }

    _snapshotWindow(win) {
        const actor = win.get_compositor_private();
        if (!actor)
            return null;
        try {
            return {content: actor.paint_to_content(null), rect: win.get_frame_rect()};
        } catch (e) {
            console.warn(`[edge-toss] could not snapshot window: ${e.message}`);
            return null;
        }
    }

    _toss(win, drag, {target, follow}, {snapshot, side, monitor, y}) {
        // The window may have closed, or the extension gone away, since the drop.
        if (!this._overlay || !win.get_compositor_private())
            return;

        // Put it back as it was before the drag. That also undoes any tile.
        if (win.get_maximize_flags() !== 0)
            win.unmaximize();
        const r = drag.frameRect;
        win.move_resize_frame(false, r.x, r.y, r.width, r.height);
        if (drag.wasMaximized)
            win.maximize();

        const manager = global.workspace_manager;
        let workspace;
        if (target.index < 0) {
            // Not Main.wm.insertWorkspace(): it shifts every window and re-activates the
            // current workspace under a new index, which on GNOME 50 plays a full
            // workspace slide. Reordering leaves the active workspace alone.
            workspace = manager.append_new_workspace(false, global.get_current_time());
            manager.reorder_workspace(workspace, 0);
        } else {
            workspace = manager.get_workspace_by_index(target.index);
        }
        if (!workspace)
            return;

        win.change_workspace(workspace);

        if (follow) {
            workspace.activate_with_focus(win, global.get_current_time());
            return;
        }

        if (snapshot)
            this._overlay.flyOut(snapshot.content, snapshot.rect, side, monitor);
        this._overlay.confirm(side, target, monitor, y);
    }
}
