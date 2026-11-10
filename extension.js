// Drag to Workspace: drag a window to a screen edge to throw it onto another workspace.
//
// Sharing the edge with GNOME's half-tiling: Mutter decides to tile from the
// pointer position during the drag, and nothing exposes a way to veto it. Flipping
// org.gnome.mutter edge-tiling mid-drag does not work, because Mutter keeps the
// tile mode it already chose once the setting goes off (meta-window-drag.c), and a
// crash would leave the setting off for good. So while Drag to Workspace owns the pointer
// it hides the tile preview, lets Mutter tile on release if it wants to, and undoes
// that before the next frame as it moves the window away.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {TilePreview} from 'resource:///org/gnome/shell/ui/windowManager.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {computeTargets, DragSession} from './lib/logic.js';
import {Overlay} from './lib/ui.js';
import {hasMaximizedState, isMaximized, maximize, unmaximize} from './lib/windowState.js';

const POLL_MS = 16;

const ARROWS = {
    horizontal: {left: '\u2190', right: '\u2192'},
    vertical: {left: '\u2191', right: '\u2193'},
};

// Not Shift: Mutter treats Shift during a drag as snap mode, which clears any pending
// tile and makes it ignore the button release (meta-window-drag.c). Ctrl only makes the
// window stick to other windows' edges, and the window gets put back anyway.
const MODIFIER_MASKS = {
    ctrl: Clutter.ModifierType.CONTROL_MASK,
    alt: Clutter.ModifierType.MOD1_MASK,
    none: 0,
};

const MOVABLE_TYPES = new Set([
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
]);

const ANY_BUTTON = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK |
    Clutter.ModifierType.BUTTON3_MASK | Clutter.ModifierType.BUTTON4_MASK |
    Clutter.ModifierType.BUTTON5_MASK;

const FRAME_HOLD_MS = 500;
const WORKSPACE_HOLD_MS = 1500;

// Keycodes of the number row, which stay the same whatever the keyboard layout.
const FIRST_NUMBER_KEYCODE = 10;
const LAST_NUMBER_KEYCODE = 18;

const BUTTONS_UP_POLL_MS = 16;
// Seat state changes before the main loop has processed the release, so "up" has to hold
// for a couple of polls before Clutter has caught up.
const BUTTONS_UP_POLLS = 2;
const BUTTONS_UP_GIVE_UP_MS = 15000;

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

function numberFromKey(event) {
    const keycode = event.get_key_code();
    if (keycode >= FIRST_NUMBER_KEYCODE && keycode <= LAST_NUMBER_KEYCODE)
        return keycode - FIRST_NUMBER_KEYCODE + 1;

    const symbol = event.get_key_symbol();
    if (symbol >= Clutter.KEY_KP_1 && symbol <= Clutter.KEY_KP_9)
        return symbol - Clutter.KEY_KP_1 + 1;
    return 0;
}

function appIdOf(win) {
    return Shell.WindowTracker.get_default().get_window_app(win)?.get_id();
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

export default class DragToWorkspaceExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._wmSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        this._overlay = new Overlay();
        this._drag = null;

        // Hide Mutter's tile preview while a drop would move the window.
        const self = this;
        this._injections = new InjectionManager();
        this._injections.overrideMethod(TilePreview.prototype, 'open', original => function (...args) {
            if (self._drag?.session.ownsPointer)
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
        this._cancelPendingSwitch();
        this._stopHoldingFrame();
        if (this._tossLaterId) {
            global.compositor.get_laters().remove(this._tossLaterId);
            this._tossLaterId = 0;
        }
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = null;
        this._injections.clear();
        this._injections = null;
        this._overlay.destroy();
        this._overlay = null;
        this._wmSettings = null;
        this._settings = null;
    }

    _onGrabBegin(win, op) {
        this._cancelDrag();
        this._cancelPendingSwitch();
        this._stopHoldingFrame();
        this._overlay.closeMoved();
        if (!isMouseMove(op) || !canToss(win) || Main.overview.visible)
            return;
        if (this._settings.get_strv('excluded-apps').includes(appIdOf(win)))
            return;

        const monitors = snapshotMonitors();
        const originMonitor = monitors[win.get_monitor()] ?? monitors[0];
        if (!originMonitor)
            return;

        const settings = this._settings;
        const zone = side => ({
            enabled: settings.get_boolean(`${side}-enabled`),
            start: settings.get_int(`${side}-zone-start`) / 100,
            end: settings.get_int(`${side}-zone-end`) / 100,
        });
        const primaryOnly = settings.get_string('monitors') === 'primary';
        const offerNew = settings.get_boolean('offer-new-workspace');
        const followKey = settings.get_string('follow-modifier');
        const appKey = settings.get_string('app-modifier');

        const drag = {
            window: win,
            originWorkspace: win.get_workspace(),
            monitors,
            originMonitor,
            frameRect: win.get_frame_rect(),
            wasMaximized: isMaximized(win),
            modifierMask: MODIFIER_MASKS[followKey],
            // If they're set to the same key, going with the window wins.
            appMask: appKey === followKey ? 0 : MODIFIER_MASKS[appKey],
            rightClickToGo: settings.get_boolean('right-click-to-go'),
            numberKeys: settings.get_boolean('number-keys'),
            // A touch or pen drag doesn't move the pointer or hold a mouse button, so its
            // position has to come from its events.
            usesEventPosition: (global.get_pointer()[2] & ANY_BUTTON) === 0,
            eventPosition: null,
            touchSlot: -1,
            ownedPointer: false,
            options: {
                showHint: settings.get_boolean('show-hint'),
                showConfirmation: settings.get_boolean('show-confirmation'),
                popupDuration: settings.get_int('popup-duration-ms'),
                popupButtons: settings.get_string('popup-buttons'),
                popupPosition: settings.get_string('popup-position'),
                animateThrow: settings.get_boolean('animate-throw'),
                showAppIcons: settings.get_boolean('show-app-icons'),
                workspaceNames: settings.get_boolean('show-workspace-names')
                    ? this._wmSettings.get_strv('workspace-names')
                    : [],
                arrows: ARROWS[global.workspace_manager.layout_columns === 1 ? 'vertical' : 'horizontal'],
            },
            session: new DragSession({
                getTargets: side => this._targetsFor(win, this._homeWorkspace(drag), side, offerNew),
                band: settings.get_int('edge-depth'),
                aspect: originMonitor.width / originMonitor.height,
                zones: {left: zone('left'), right: zone('right')},
                allowMonitor: index => !primaryOnly || index === Main.layoutManager.primaryIndex,
                holdDelay: settings.get_int('hold-delay-ms'),
                followDelay: settings.get_int('follow-delay-ms'),
                followStartDelay: settings.get_int('follow-start-delay-ms'),
                pickerGesture: settings.get_string('picker-gesture'),
                splitSide: settings.get_string('split-side'),
                splitPercent: settings.get_int('split-percent'),
                dropAction: settings.get_string('drop-action'),
                cardWidth: settings.get_int('card-width'),
                sharedEdges: settings.get_boolean('shared-edges'),
                topEdge: settings.get_boolean('top-edge'),
            }),
        };
        this._drag = drag;

        // A filter sees each event first, even with the drag's grab in place.
        this._eventFilterId = Clutter.Event.add_filter(global.stage, event => {
            this._onDragEvent(drag, event);
            return Clutter.EVENT_PROPAGATE;
        });

        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        GLib.Source.set_name_by_id(this._pollId, '[drag-to-workspace] drag poll');
        this._tick();
    }

    _onDragEvent(drag, event) {
        switch (event.type()) {
        case Clutter.EventType.KEY_PRESS:
            // Mutter ends the drag on Escape, and the signal doesn't say why.
            if (event.get_key_symbol() === Clutter.KEY_Escape)
                drag.escaped = true;
            else if (drag.numberKeys && numberFromKey(event))
                drag.session.chooseNumber(numberFromKey(event));
            break;
        case Clutter.EventType.BUTTON_PRESS:
            // The same goes for an extra button press, and the button state read afterwards
            // may have moved on.
            drag.extraButtonPressed = true;
            if (event.get_button() === Clutter.BUTTON_SECONDARY)
                drag.rightClicked = true;
            break;
        case Clutter.EventType.TOUCH_CANCEL:
            drag.escaped = true;
            break;
        case Clutter.EventType.TOUCH_UPDATE:
        case Clutter.EventType.TOUCH_END:
            this._trackTouch(drag, event);
            break;
        case Clutter.EventType.MOTION:
            if (drag.usesEventPosition)
                drag.eventPosition = event.get_coords();
            break;
        }
    }

    /** Follows the first finger that moves. Mutter's drag ignores any others too. */
    _trackTouch(drag, event) {
        if (!drag.usesEventPosition)
            return;
        const slot = event.get_event_sequence().get_slot();
        if (drag.touchSlot < 0)
            drag.touchSlot = slot;
        if (slot === drag.touchSlot)
            drag.eventPosition = event.get_coords();
    }

    /** Where the drag is now, or null for a touch drag that hasn't reported yet. */
    _dragPosition(drag) {
        return drag.usesEventPosition ? drag.eventPosition : global.get_pointer();
    }

    /**
     * The workspace the window is leaving. On a monitor without workspaces a window is on
     * all of them, so while it's being dragged over one, the last real one counts.
     */
    _homeWorkspace(drag) {
        if (!drag.window.is_on_all_workspaces())
            drag.originWorkspace = drag.window.get_workspace();
        return drag.originWorkspace;
    }

    _targetsFor(win, workspace, side, offerNew) {
        const manager = global.workspace_manager;
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
            offerNew,
        });
    }

    _tick() {
        const drag = this._drag;
        if (!drag)
            return;

        const position = this._dragPosition(drag);
        if (!position)
            return;

        const [x, y] = position;
        const [, , mods] = global.get_pointer();
        drag.session.update(x, y, GLib.get_monotonic_time() / 1000, drag.monitors);

        // The preview may already be up if Mutter got there before us.
        if (drag.session.ownsPointer && !drag.ownedPointer)
            Main.wm._hideTilePreview();
        drag.ownedPointer = drag.session.ownsPointer;

        this._overlay.render(drag.session, {
            monitors: drag.monitors,
            originMonitor: drag.originMonitor,
            draggedWindow: drag.window,
            options: drag.options,
            modifierHeld: (mods & drag.modifierMask) !== 0,
            allWindowsHeld: (mods & drag.appMask) !== 0,
            arrows: drag.options.arrows,
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
        if (this._eventFilterId) {
            Clutter.Event.remove_filter(this._eventFilterId);
            this._eventFilterId = 0;
        }
        this._drag = null;
        this._overlay.clear();
    }

    _onGrabEnd(win, op) {
        const drag = this._drag;
        if (!drag || drag.window !== win || !isMouseMove(op))
            return;

        this._tick();
        const [, , mods] = global.get_pointer();
        const [x, y] = this._dragPosition(drag) ?? [0, 0];
        // After Escape, Mutter has already put the window back, so there is nothing to throw.
        const modifierHeld = (mods & drag.modifierMask) !== 0;
        const goNow = drag.rightClickToGo && drag.rightClicked;
        const decision = drag.escaped ? null : drag.session.decide(modifierHeld, goNow);
        const buttonsHeld = drag.extraButtonPressed || (mods & ANY_BUTTON) !== 0;
        const allWindows = (mods & drag.appMask) !== 0;
        const session = drag.session;
        const monitor = drag.monitors[session.monitorIndex] ??
            drag.monitors[session.pointerMonitor] ??
            drag.originMonitor;
        const side = session.side === 'left' || session.side === 'right'
            ? session.side
            : this._sideOf(decision, this._homeWorkspace(drag));

        this._cancelDrag();
        if (!decision)
            return;

        // With a button still down the view can't switch yet, so it looks like a throw until then.
        const switchesNow = decision.follow && !buttonsHeld;
        const snapshot = switchesNow || !drag.options.animateThrow
            ? null
            : this._snapshotWindow(win);
        this._tossLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._tossLaterId = 0;
            this._toss(win, drag, decision, {snapshot, side, monitor, x, y, switchesNow, allWindows});
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Which way a window goes when it wasn't dropped on a side edge. */
    _sideOf(decision, origin) {
        return decision && decision.target.index < origin.index() ? 'left' : 'right';
    }

    /** The other windows of the same app on the same workspace. */
    _appWindowsWith(win, origin) {
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        if (!app)
            return [];
        return app.get_windows().filter(w => w !== win &&
            w.get_workspace() === origin &&
            !w.get_transient_for() &&
            canToss(w));
    }

    _snapshotWindow(win) {
        const actor = win.get_compositor_private();
        return {content: actor.paint_to_content(null), rect: win.get_frame_rect()};
    }

    _toss(win, drag, {target, follow}, {snapshot, side, monitor, x, y, switchesNow, allWindows}) {
        // The window may have closed since the drop.
        if (!win.get_compositor_private())
            return;

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

        const origin = this._homeWorkspace(drag);
        const others = allWindows ? this._appWindowsWith(win, origin) : [];
        const moved = [win, ...others];

        // Put it back as it was before the drag, which also undoes any tile, and send it.
        if (hasMaximizedState(win))
            unmaximize(win);
        this._holdInPlace(win, drag.wasMaximized ? null : drag.frameRect, workspace);
        if (drag.wasMaximized)
            maximize(win);
        others.forEach(w => w.change_workspace(workspace));

        if (switchesNow) {
            workspace.activate_with_focus(win, global.get_current_time());
            return;
        }
        if (follow)
            this._switchOnceButtonsUp(win, workspace);

        if (snapshot)
            this._overlay.flyOut(snapshot.content, snapshot.rect, side, monitor);
        if (drag.options.showConfirmation && !follow) {
            this._overlay.showMoved({
                side,
                target,
                monitor,
                y,
                x,
                count: moved.length,
                buttons: drag.options.popupButtons,
                duration: drag.options.popupDuration,
                position: drag.options.popupPosition,
                onUndo: () => this._undoMove(moved, origin),
                onGo: () => this._switchOnceButtonsUp(win, workspace),
            });
        }
    }

    _undoMove(windows, origin) {
        this._stopHoldingFrame();
        const manager = global.workspace_manager;
        const stillExists = manager.get_workspace_by_index(origin.index()) === origin;
        const workspace = stillExists ? origin : manager.get_active_workspace();

        const alive = windows.filter(w => w.get_compositor_private());
        alive.forEach(w => w.change_workspace(workspace));
        if (alive.length > 0 && workspace.active)
            alive[0].activate(global.get_current_time());
    }

    /**
     * Switches workspace after every mouse button is up. The switch animation grabs the
     * stage, and with a button held that can trip an assertion in Clutter that aborts the
     * whole shell (clutter_sprite_notify_grab). A right-click during a drag always leaves
     * the left button held, and a click on Go is still being handled.
     */
    _switchOnceButtonsUp(win, workspace) {
        this._cancelPendingSwitch();

        const started = GLib.get_monotonic_time();
        let upPolls = 0;
        this._pendingSwitchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BUTTONS_UP_POLL_MS, () => {
            const [, , mods] = global.get_pointer();
            upPolls = (mods & ANY_BUTTON) === 0 ? upPolls + 1 : 0;

            const waited = (GLib.get_monotonic_time() - started) / 1000;
            if (upPolls < BUTTONS_UP_POLLS && waited < BUTTONS_UP_GIVE_UP_MS)
                return GLib.SOURCE_CONTINUE;

            this._pendingSwitchId = 0;
            // On giving up the window has still been thrown, you just haven't followed it.
            const stillThere = win.get_compositor_private() && win.get_workspace() === workspace;
            if (upPolls >= BUTTONS_UP_POLLS && stillThere)
                workspace.activate_with_focus(win, global.get_current_time());
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._pendingSwitchId, '[drag-to-workspace] switch once buttons are up');
    }

    /**
     * Puts a window back where it was before the drag, sends it to its workspace, and keeps
     * it that way for a moment. On older versions of GNOME, the app's replies to the
     * updates sent at the end of the drag arrive later, and move the window back to where it
     * was dropped or tiled. Being dropped on a monitor without workspaces also puts it on
     * every workspace until it's back on its own monitor. `rect` is null to leave its size
     * alone, as for a maximized window.
     */
    _holdInPlace(win, rect, workspace) {
        this._stopHoldingFrame();

        const hold = {win, laterId: 0, workspaceTimeoutId: 0};
        const placeFrame = () => {
            if (hold.rect && !win.get_frame_rect().equal(hold.rect))
                win.move_resize_frame(false, hold.rect.x, hold.rect.y, hold.rect.width, hold.rect.height);
        };
        // Only while the move hasn't taken, so that a later move of the window, by you or
        // anything else, isn't undone. A window bouncing through a monitor without
        // workspaces comes back on the current one, so that counts as not taken.
        const sendToWorkspace = () => {
            if (!hold.workspace)
                return;
            win.change_workspace(hold.workspace);
            if (win.get_workspace() === hold.workspace && !win.is_on_all_workspaces())
                hold.workspace = null;
        };

        hold.rect = rect;
        hold.workspace = workspace;
        placeFrame();
        sendToWorkspace();

        // Not straight away: Mutter is still handling the change when these signals fire,
        // and it would overwrite this as it finishes.
        const onChanged = () => {
            if (win.is_on_all_workspaces())
                hold.workspace = workspace;
            if (hold.laterId)
                return;
            hold.laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                hold.laterId = 0;
                placeFrame();
                sendToWorkspace();
                return GLib.SOURCE_REMOVE;
            });
        };
        hold.signalIds = [
            win.connect('position-changed', onChanged),
            win.connect('size-changed', onChanged),
            win.connect('workspace-changed', onChanged),
        ];
        hold.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_HOLD_MS, () => {
            hold.timeoutId = 0;
            hold.rect = null;
            return GLib.SOURCE_REMOVE;
        });
        hold.workspaceTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WORKSPACE_HOLD_MS, () => {
            hold.workspaceTimeoutId = 0;
            this._stopHoldingFrame();
            return GLib.SOURCE_REMOVE;
        });
        this._frameHold = hold;
    }

    _stopHoldingFrame() {
        if (!this._frameHold)
            return;
        const {win, signalIds, timeoutId, workspaceTimeoutId, laterId} = this._frameHold;
        signalIds.forEach(id => win.disconnect(id));
        if (timeoutId)
            GLib.source_remove(timeoutId);
        if (workspaceTimeoutId)
            GLib.source_remove(workspaceTimeoutId);
        if (laterId)
            global.compositor.get_laters().remove(laterId);
        this._frameHold = null;
    }


    _cancelPendingSwitch() {
        if (this._pendingSwitchId) {
            GLib.source_remove(this._pendingSwitchId);
            this._pendingSwitchId = 0;
        }
    }
}
