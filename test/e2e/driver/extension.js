// Runs inside the sandboxed shell. Drives a virtual pointer against real GTK windows,
// checks the outcome through Mutter, writes results.json and quits the shell.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot');

const BTN_LEFT = Clutter.BUTTON_PRIMARY;
const KEY_SHIFT = 0xffe1;
const KEY_ESCAPE = 0xff1b;
const ARM_SETTLE = 60;
const OUT = GLib.getenv('EDGE_TOSS_OUT');
const SCENARIO = GLib.getenv('EDGE_TOSS_SCENARIO') ?? 'single';
const CLIENT = GLib.getenv('EDGE_TOSS_CLIENT');

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

const now = () => GLib.get_monotonic_time();
const manager = () => global.workspace_manager;
const activeIndex = () => manager().get_active_workspace_index();
const rectOf = win => {
    const r = win.get_frame_rect();
    return {x: r.x, y: r.y, width: r.width, height: r.height};
};

class Failure extends Error {}

function check(condition, message) {
    if (!condition)
        throw new Failure(message);
}

function sameRect(a, b, slack = 2) {
    return ['x', 'y', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) <= slack);
}

export default class DriverExtension extends Extension {
    enable() {
        // Disabling Edge Toss in a test makes the shell cycle extensions enabled after it.
        if (globalThis.__edgeTossDriverStarted)
            return;
        globalThis.__edgeTossDriverStarted = true;

        const seat = Clutter.get_default_backend().get_default_seat();
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._results = [];
        this._grabs = [];
        global.display.connect('grab-op-begin', (_d, _w, op) => this._grabs.push(op));

        sleep(4000).then(() => this._run()).catch(e => this._finish(`driver crashed: ${e}\n${e.stack}`));
    }

    disable() {}

    // ---- input ----

    async _moveTo(x, y, {steps = 12, stepMs = 8} = {}) {
        const [sx, sy] = global.get_pointer();
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            this._pointer.notify_absolute_motion(now(), sx + (x - sx) * t, sy + (y - sy) * t);
            await sleep(stepMs);
        }
    }

    _button(pressed) {
        this._pointer.notify_button(now(), BTN_LEFT,
            pressed ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED);
    }

    _key(keyval, pressed) {
        this._keyboard.notify_keyval(now(), keyval,
            pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
    }

    /** Presses on the header bar and pulls until Mutter has started the move. */
    async _grabTitlebar(win, {offsetX} = {}) {
        const r = win.get_frame_rect();
        const x = r.x + (offsetX ?? r.width / 2);
        const y = r.y + 22;
        await this._moveTo(x, y);
        await sleep(80);
        this._grabs = [];
        this._button(true);
        await sleep(60);
        for (let i = 1; i <= 8 && this._grabs.length === 0; i++) {
            await this._moveTo(x, y + i * 3, {steps: 2});
            await sleep(30);
        }
        check(this._grabs.length > 0, 'the drag never started a grab');
        await sleep(40);
    }

    async _drop() {
        this._button(false);
        await sleep(300);
    }

    // ---- windows ----

    _spawn(title) {
        GLib.spawn_async(null, ['gjs', '-m', CLIENT, title], null, GLib.SpawnFlags.SEARCH_PATH, null);
    }

    _find(title) {
        return global.display.list_all_windows().find(w => w.get_title() === title);
    }

    async _waitWindow(title) {
        for (let i = 0; i < 100; i++) {
            const win = this._find(title);
            if (win && win.get_compositor_private())
                return win;
            await sleep(100);
        }
        throw new Failure(`window ${title} never appeared`);
    }

    async _closeOverview() {
        for (let i = 0; i < 50 && (Main.overview.visible || Main.overview.animationInProgress); i++) {
            Main.overview.hide();
            await sleep(200);
        }
        check(!Main.overview.visible, 'the overview would not close');
    }

    /** Back to a known layout: workspace 1 active, every window on it, in place. */
    async _reset() {
        this._key(KEY_ESCAPE, false);
        this._button(false);
        manager().get_workspace_by_index(0).activate(global.get_current_time());
        // Moving a window onto a workspace mid-animation trips a bug in the shell's
        // workspaceAnimation.js (_syncStacking), so let the switch finish first.
        await sleep(600);
        const place = [[120, 120], [860, 420], [400, 300], [500, 150]];
        ['A', 'B', 'C', 'D'].forEach((title, i) => {
            const win = this._find(title);
            if (!win)
                return;
            if (win.get_maximize_flags() !== 0)
                win.unmaximize();
            win.change_workspace_by_index(0, false);
            win.move_resize_frame(false, place[i][0], place[i][1], 640, 420);
            win.unminimize();
        });
        await sleep(400);
        this._find('A')?.activate(global.get_current_time());
        await sleep(150);
        this._pointer.notify_absolute_motion(now(), 800, 700);
        await sleep(50);
        await this._closeOverview();
        for (let i = 0; i < 40 && manager().get_n_workspaces() > 2; i++)
            await sleep(100);
        check(manager().get_n_workspaces() <= 2, `reset left ${manager().get_n_workspaces()} workspaces`);
    }

    /** Spreads windows so workspaces exist on both sides of the active one. */
    async _spreadWorkspaces(windows) {
        for (let i = 0; i < windows.length; i++) {
            const win = this._find(windows[i]);
            win.change_workspace_by_index(i, true);
            await sleep(150);
        }
    }

    // ---- evidence ----

    async _shot(name) {
        const path = GLib.build_filenamev([OUT, `${name}.png`]);
        const file = Gio.File.new_for_path(path);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        const shooter = new Shell.Screenshot();
        await shooter.screenshot(false, stream);
        stream.close(null);
    }

    _shellLooksIdle(extension) {
        const overlay = extension.stateObj._overlay;
        return !extension.stateObj._drag && !overlay._picker && !overlay._tab.visible;
    }

    // ---- scenarios ----

    async _test(name, fn) {
        const started = Date.now();
        console.log(`[edge-toss-driver] TEST ${name}`);
        try {
            await this._reset();
            console.log('[edge-toss-driver] RESET DONE');
            await fn();
            this._results.push({name, ok: true, ms: Date.now() - started});
        } catch (e) {
            this._results.push({name, ok: false, message: `${e.message}${e instanceof Failure ? '' : `\n${e.stack}`}`});
            this._key(KEY_SHIFT, false);
            this._button(false);
            await sleep(200);
        }
    }

    async _singleMonitorTests(toss) {
        const W = global.display.get_monitor_geometry(0).width;
        const H = global.display.get_monitor_geometry(0).height;
        const RIGHT = W - 1;
        const session = () => toss.stateObj._drag?.session;

        await this._test('quick drop right: next workspace, stay here, window as it was', async () => {
            const a = this._find('A');
            const before = rectOf(a);
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(ARM_SETTLE);
            check(session().phase === 'armed', `phase was ${session().phase}`);
            await this._drop();
            check(a.get_workspace().index() === 1, `A on workspace ${a.get_workspace().index()}`);
            check(activeIndex() === 0, `active is ${activeIndex()}`);
            check(sameRect(rectOf(a), before), `rect ${JSON.stringify(rectOf(a))} vs ${JSON.stringify(before)}`);
            check(a.get_maximize_flags() === 0, 'A was left tiled');
            const focus = global.display.focus_window;
            check(focus && focus !== a && focus.get_workspace().index() === 0,
                `focus went to ${focus?.get_title()}`);
        });

        await this._test('the hint and the tab show up on the way to the edge', async () => {
            // Slow the hold right down so the screenshots land before the picker opens.
            const settings = toss.stateObj.getSettings();
            settings.set_int('hold-delay-ms', 1500);
            const a = this._find('A');
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT - 120, 300);
            await sleep(60);
            check(session().hint?.side === 'right', 'no hint near the edge');
            await this._shot('00-hint');
            await this._moveTo(RIGHT, 300);
            await sleep(ARM_SETTLE);
            check(session().phase === 'armed', `phase was ${session().phase}`);
            await this._shot('01-armed-tab');
            settings.reset('hold-delay-ms');
            await this._moveTo(800, 500);
            await this._drop();
        });

        await this._test('quick drop with Shift goes with the window', async () => {
            const a = this._find('A');
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(ARM_SETTLE);
            this._key(KEY_SHIFT, true);
            await sleep(40);
            await this._drop();
            this._key(KEY_SHIFT, false);
            await sleep(500);
            check(a.get_workspace().index() === 1, `A on workspace ${a.get_workspace().index()}`);
            check(activeIndex() === 1, `active is ${activeIndex()}`);
            check(global.display.focus_window === a, `focus is ${global.display.focus_window?.get_title()}`);
        });

        await this._test('quick drop left on the first workspace makes a new one before it', async () => {
            const a = this._find('A');
            const b = this._find('B');
            await this._grabTitlebar(a);
            await this._moveTo(0, 300);
            await sleep(ARM_SETTLE);
            this._slides = 0;
            await this._drop();
            await sleep(300);
            check(this._slides === 0, `played ${this._slides} workspace slides while staying`);
            check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
            check(b.get_workspace().index() === 1, `B on ${b.get_workspace().index()}`);
            check(activeIndex() === 1, `active is ${activeIndex()}, should follow B's workspace`);
        });

        await this._test('new workspace on the left, with Shift: goes there', async () => {
            const a = this._find('A');
            const b = this._find('B');
            await this._grabTitlebar(a);
            await this._moveTo(0, 300);
            await sleep(ARM_SETTLE);
            this._key(KEY_SHIFT, true);
            await sleep(40);
            await this._drop();
            this._key(KEY_SHIFT, false);
            await sleep(600);
            check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
            check(b.get_workspace().index() === 1, `B on ${b.get_workspace().index()}`);
            check(activeIndex() === 0, `active is ${activeIndex()}`);
            check(global.display.focus_window === a, `focus is ${global.display.focus_window?.get_title()}`);
        });

        await this._test('hold opens the picker: choose a far workspace, stay here', async () => {
            await this._spreadWorkspaces(['A', 'B', 'C']);
            manager().get_workspace_by_index(0).activate(global.get_current_time());
            await sleep(500);
            // Screenshots are slow, and must not complete the hold that follows the window.
            const settings = toss.stateObj.getSettings();
            settings.set_int('follow-delay-ms', 3000);
            const d = this._find('D');
            await this._grabTitlebar(d);
            await this._moveTo(RIGHT, 300);
            await sleep(450);
            check(session().phase === 'picker', `phase was ${session().phase}`);
            check(session().targets.map(t => t.index).join() === '1,2,3', `targets ${session().targets.map(t => t.index)}`);
            await sleep(200);
            await this._shot('02-picker-nearest');

            const rect = session().layout.rects[1];
            await this._moveTo(RIGHT, rect.y + rect.height / 2);
            await sleep(100);
            check(session().selected === 1, `selected ${session().selected}`);
            await this._shot('03-picker-far');
            await this._drop();
            settings.reset('follow-delay-ms');
            check(d.get_workspace().index() === 2, `D on ${d.get_workspace().index()}`);
            check(activeIndex() === 0, `active is ${activeIndex()}`);
        });

        await this._test('holding on a card goes with the window', async () => {
            const a = this._find('A');
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(450);
            check(session().phase === 'picker', `phase was ${session().phase}`);
            await sleep(1300);
            check(session().willFollow(false), 'should be following after the dwell');
            await this._shot('04-picker-follow');
            await this._drop();
            await sleep(500);
            check(activeIndex() === 1, `active is ${activeIndex()}`);
            check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
        });

        await this._test('dragging back out of the picker is an ordinary move', async () => {
            const a = this._find('A');
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(450);
            check(session().phase === 'picker', `phase was ${session().phase}`);
            await this._moveTo(900, 500);
            await sleep(80);
            check(session().phase === 'idle', `phase was ${session().phase}`);
            check(!toss.stateObj._overlay._picker, 'picker still up');
            await this._drop();
            check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
        });

        await this._test('bottom of the edge still half-tiles', async () => {
            const a = this._find('A');
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, H - 60);
            await sleep(400);
            check(session().phase === 'idle', `phase was ${session().phase}`);
            check(Main.wm._tilePreview?.visible, 'no tile preview');
            await this._shot('05-tile-zone');
            await this._drop();
            await sleep(300);
            check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
            check(a.get_maximize_flags() !== 0, 'A did not tile');
            check(rectOf(a).x >= W / 2 - 2, `A at x=${rectOf(a).x}`);
        });

        await this._test('sliding from the tiling part to the toss part: throws and undoes the tile', async () => {
            const a = this._find('A');
            const before = rectOf(a);
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, H - 60);
            await sleep(350);
            check(Main.wm._tilePreview?.visible, 'no tile preview to go stale');
            await this._moveTo(RIGHT, 300);
            await sleep(ARM_SETTLE + 300);
            check(!Main.wm._tilePreview?.visible, 'tile preview still showing in the toss zone');
            await this._shot('06-stale-tile-suppressed');
            await this._drop();
            await sleep(300);
            check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
            check(a.get_maximize_flags() === 0, 'A was left tiled');
            check(sameRect(rectOf(a), before), `rect ${JSON.stringify(rectOf(a))} vs ${JSON.stringify(before)}`);
        });

        await this._test('Escape cancels: no throw, window back', async () => {
            const a = this._find('A');
            const before = rectOf(a);
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(ARM_SETTLE);
            this._key(KEY_ESCAPE, true);
            this._key(KEY_ESCAPE, false);
            await sleep(150);
            check(this._shellLooksIdle(toss), 'overlay still up after Escape');
            this._button(false);
            await sleep(250);
            check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
            check(sameRect(rectOf(a), before), `rect ${JSON.stringify(rectOf(a))} vs ${JSON.stringify(before)}`);
        });

        await this._test('resizing into the edge does nothing', async () => {
            const a = this._find('A');
            const r = rectOf(a);
            const x = r.x + r.width + 3;
            const y = r.y + r.height / 2;
            await this._moveTo(x, y);
            await sleep(80);
            this._grabs = [];
            this._button(true);
            await sleep(60);
            await this._moveTo(x + 30, y, {steps: 6});
            await sleep(60);
            check(this._grabs.includes(Meta.GrabOp.RESIZING_E), `grabs were ${this._grabs}`);
            check(!toss.stateObj._drag, 'a resize started a session');
            await this._moveTo(RIGHT, y);
            await sleep(450);
            check(!toss.stateObj._overlay._picker, 'picker opened on resize');
            await this._drop();
            check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
            check(rectOf(a).width > r.width, 'resize did not take effect');
        });

        await this._test('a maximized window comes back maximized', async () => {
            const a = this._find('A');
            a.maximize();
            await sleep(400);
            check(a.is_maximized(), 'A did not maximize');
            await this._grabTitlebar(a, {offsetX: 400});
            await this._moveTo(800, 400);
            await sleep(120);
            check(!a.is_maximized(), 'A did not shake loose');
            await this._moveTo(RIGHT, 300);
            await sleep(ARM_SETTLE);
            await this._drop();
            await sleep(300);
            check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
            check(a.is_maximized(), 'A lost maximize');
        });

        await this._test('a grab that starts on the edge does not throw', async () => {
            const a = this._find('A');
            a.move_frame(false, W - 400, 200);
            await sleep(250);
            const offsetX = rectOf(a).width > 380 ? 380 : rectOf(a).width - 20;
            await this._grabTitlebar(a, {offsetX});
            await sleep(100);
            check(session()?.phase === 'idle', `phase was ${session()?.phase}`);
            await this._drop();
            check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
        });

        await this._test('a lone window has no new workspace to go to, so the edge tiles', async () => {
            // A alone on workspace 1, the rest pushed over to workspace 2.
            const a = this._find('A');
            for (const t of ['B', 'C', 'D'])
                this._find(t).change_workspace_by_index(1, true);
            await sleep(300);
            manager().get_workspace_by_index(0).activate(global.get_current_time());
            await sleep(300);
            await this._grabTitlebar(a);
            await this._moveTo(0, 300);
            await sleep(350);
            check(session().phase === 'idle', `phase was ${session().phase}`);
            check(Main.wm._tilePreview?.visible, 'no tile preview');
            await this._drop();
            check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
            check(a.get_maximize_flags() !== 0, 'A did not tile');
        });

        await this._test('static workspaces: last workspace has nothing to the right', async () => {
            const mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
            const wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
            mutter.set_boolean('dynamic-workspaces', false);
            wm.set_int('num-workspaces', 2);
            await sleep(400);
            try {
                manager().get_workspace_by_index(1).activate(global.get_current_time());
                await sleep(600);
                const a = this._find('A');
                a.change_workspace_by_index(1, true);
                this._find('B').change_workspace_by_index(1, true);
                await sleep(400);
                a.activate(global.get_current_time());
                await sleep(150);
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT, 300);
                await sleep(ARM_SETTLE + 200);
                check(session().phase === 'idle', `phase was ${session().phase}`);
                await this._drop();
                check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
                check(manager().get_n_workspaces() === 2, 'workspaces changed');
            } finally {
                mutter.set_boolean('dynamic-workspaces', true);
                await sleep(400);
            }
        });

        await this._test('many workspaces all fit in the picker', async () => {
            for (let i = 0; i < 10; i++)
                manager().append_new_workspace(false, global.get_current_time());
            await sleep(200);
            // Dynamic workspaces collapse empty ones, so make them stick.
            const mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
            mutter.set_boolean('dynamic-workspaces', false);
            const wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
            wm.set_int('num-workspaces', 14);
            await sleep(400);
            try {
                const a = this._find('A');
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT, 300);
                await sleep(500);
                check(session().phase === 'picker', `phase was ${session().phase}`);
                const last = session().layout.rects.at(-1);
                check(last.y + last.height <= H, `last card ends at ${last.y + last.height}`);
                await this._shot('07-many-workspaces');
                await this._moveTo(RIGHT, last.y + last.height / 2);
                await sleep(100);
                check(session().selected === session().targets.length - 1, `selected ${session().selected}`);
                await this._drop();
                check(a.get_workspace().index() === 13, `A on ${a.get_workspace().index()}`);
            } finally {
                mutter.set_boolean('dynamic-workspaces', true);
                await sleep(600);
            }
        });

        await this._test('workspace switched mid-drag: targets follow, window goes along', async () => {
            await this._spreadWorkspaces(['A', 'B', 'C']);
            // D keeps workspace 2 alive. Otherwise GNOME removes it once B leaves, and
            // everything renumbers.
            this._find('D').change_workspace_by_index(1, true);
            await sleep(150);
            manager().get_workspace_by_index(1).activate(global.get_current_time());
            await sleep(600);
            const b = this._find('B');
            b.activate(global.get_current_time());
            await sleep(150);
            await this._grabTitlebar(b);
            await this._moveTo(RIGHT, 300);
            await sleep(450);
            check(session().phase === 'picker', `phase was ${session().phase}`);
            const before = session().targets.map(t => t.index).join();
            // Mutter ignores plain workspace activation during a move grab, so this is
            // the path that really happens: another extension or binding moves the window.
            Main.wm.actionMoveWindow(b, manager().get_workspace_by_index(2));
            await sleep(600);
            check(session().targets.map(t => t.index).join() !== before,
                `targets stayed ${before}; active ${activeIndex()}, B on ${b.get_workspace().index()}, phase ${session().phase}`);
            await this._drop();
            check(b.get_workspace().index() === 3, `B on ${b.get_workspace().index()}`);
        });

        await this._test('disabling mid-drag cleans up and the drag finishes normally', async () => {
            const a = this._find('A');
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(450);
            check(session().phase === 'picker', `phase was ${session().phase}`);
            const children = Main.layoutManager.uiGroup.get_n_children();
            await Main.extensionManager.disableExtension(toss.uuid);
            await sleep(100);
            check(Main.layoutManager.uiGroup.get_n_children() < children, 'overlay left behind');
            await this._drop();
            check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
            await Main.extensionManager.enableExtension(toss.uuid);
            await sleep(200);
        });
    }

    async _dualMonitorTests(toss) {
        const session = () => toss.stateObj._drag?.session;
        const g0 = global.display.get_monitor_geometry(0);
        const g1 = global.display.get_monitor_geometry(1);
        const [left, right] = g0.x < g1.x ? [g0, g1] : [g1, g0];
        const shared = new Gio.Settings({schema_id: 'org.gnome.mutter'});

        for (const onlyPrimary of [false, true]) {
            shared.set_boolean('workspaces-only-on-primary', onlyPrimary);
            await sleep(500);
            const tag = onlyPrimary ? 'workspaces on primary only' : 'workspaces on all monitors';
            const primary = global.display.get_monitor_geometry(global.display.get_primary_monitor());
            const secondary = primary.x === left.x ? right : left;
            const place = (win, g) => {
                win.change_workspace_by_index(0, false);
                win.move_resize_frame(false, g.x + 200, g.y + 150, 640, 420);
            };

            await this._test(`${tag}: edge between monitors does not trigger`, async () => {
                const a = this._find('A');
                place(a, left);
                await sleep(300);
                a.activate(global.get_current_time());
                await sleep(100);
                await this._grabTitlebar(a);
                await this._moveTo(right.x - 1, 300);
                await sleep(450);
                check(session().phase === 'idle', `phase was ${session().phase}`);
                check(!toss.stateObj._overlay._picker, 'picker opened at the shared edge');
                await this._moveTo(right.x + 400, 400);
                await sleep(80);
                await this._drop();
                check(a.get_monitor() !== -1, 'A lost its monitor');
                check(rectOf(a).x >= right.x - 400, `A did not cross, x=${rectOf(a).x}`);
            });

            await this._test(`${tag}: drag across to the far edge, window returns to where it started`, async () => {
                const a = this._find('A');
                place(a, primary);
                await sleep(300);
                a.activate(global.get_current_time());
                await sleep(100);
                const before = rectOf(a);
                const beforeMonitor = a.get_monitor();
                await this._grabTitlebar(a);
                // Whichever outer edge lies past the other monitor.
                const farRight = primary.x === left.x;
                const edgeX = farRight ? right.x + right.width - 1 : left.x;
                await this._moveTo(edgeX, 300, {steps: 24});
                await sleep(ARM_SETTLE + 40);
                const canGoThatWay = farRight; // workspace 1 has a neighbour right, left would be new
                check(session().phase === 'armed', `phase was ${session().phase}`);
                await this._shot(`10-dual-${onlyPrimary ? 'primary' : 'all'}`);
                await this._drop();
                await sleep(300);
                check(sameRect(rectOf(a), before), `rect ${JSON.stringify(rectOf(a))} vs ${JSON.stringify(before)}`);
                check(a.get_monitor() === beforeMonitor, `monitor ${a.get_monitor()}`);
                check(activeIndex() === 0 || !canGoThatWay, `active is ${activeIndex()}`);
                check(a.get_workspace().index() !== 0 || !canGoThatWay, `A stayed on ${a.get_workspace().index()}`);
                check(!a.is_on_all_workspaces(), 'A became sticky');
            });

            await this._test(`${tag}: picker opens on the monitor under the pointer`, async () => {
                const a = this._find('A');
                place(a, primary);
                await sleep(300);
                a.activate(global.get_current_time());
                await sleep(100);
                await this._grabTitlebar(a);
                const farRight = primary.x === left.x;
                const edgeX = farRight ? right.x + right.width - 1 : left.x;
                await this._moveTo(edgeX, 300, {steps: 24});
                await sleep(500);
                check(session().phase === 'picker', `phase was ${session().phase}`);
                const g = farRight ? right : left;
                check(session().monitorIndex === global.display.get_monitor_index_for_rect(g),
                    `monitor ${session().monitorIndex}`);
                await this._shot(`11-dual-picker-${onlyPrimary ? 'primary' : 'all'}`);
                await this._moveTo(primary.x + 300, 500, {steps: 24});
                await sleep(100);
                await this._drop();
            });

            if (onlyPrimary) {
                await this._test(`${tag}: a window on the secondary monitor has no workspace to leave`, async () => {
                    const a = this._find('A');
                    a.move_resize_frame(false, secondary.x + 200, secondary.y + 150, 640, 420);
                    await sleep(400);
                    check(a.is_on_all_workspaces(), 'A should span workspaces on a secondary monitor');
                    a.activate(global.get_current_time());
                    await sleep(100);
                    await this._grabTitlebar(a);
                    const edgeX = secondary.x > primary.x ? secondary.x + secondary.width - 1 : secondary.x;
                    await this._moveTo(edgeX, 300);
                    await sleep(450);
                    check(!toss.stateObj._drag, 'a session started for a window on all workspaces');
                    await this._moveTo(secondary.x + 500, 500);
                    await this._drop();
                });
            }
        }
    }

    async _run() {
        // Staying put must never play a workspace slide, so count them.
        this._slides = 0;
        const animation = Main.wm._workspaceAnimation;
        const animateSwitch = animation.animateSwitch;
        const driver = this;
        animation.animateSwitch = function (...args) {
            driver._slides++;
            return animateSwitch.apply(this, args);
        };
        const toss = Main.extensionManager.lookup('edge-toss@aahil-khan.github.com');
        check(toss?.stateObj?._overlay, `Edge Toss did not load: state=${toss?.state} error=${toss?.error}`);

        for (const title of ['A', 'B', 'C', 'D'])
            this._spawn(title);
        for (const title of ['A', 'B', 'C', 'D'])
            await this._waitWindow(title);
        await sleep(800);

        for (let i = 0; i < 100 && Main.layoutManager._startingUp; i++)
            await sleep(200);
        await sleep(1500);
        await this._closeOverview();

        if (SCENARIO === 'prefs') {
            await this._test('the settings window opens', async () => {
                await Main.extensionManager.openExtensionPrefs(toss.uuid, '', {});
                let win = null;
                for (let i = 0; i < 80 && !win; i++) {
                    await sleep(100);
                    win = global.display.list_all_windows().find(w => /Edge Toss/.test(w.get_title() ?? ''));
                }
                check(win, 'no settings window appeared');
                await sleep(800);
                win.activate(global.get_current_time());
                await sleep(400);
                await this._shot('20-prefs');
            });
            this._finish(null);
            return;
        }

        if (SCENARIO === 'dual')
            await this._dualMonitorTests(toss);
        else
            await this._singleMonitorTests(toss);

        this._finish(null);
    }

    _finish(crash) {
        const payload = JSON.stringify({scenario: SCENARIO, crash, results: this._results}, null, 2);
        GLib.file_set_contents(GLib.build_filenamev([OUT, `results-${SCENARIO}.json`]), payload);
        global.context.terminate();
    }
}
