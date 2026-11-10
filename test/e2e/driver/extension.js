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
const KEY_CONTROL = 0xffe3;
const KEY_ALT = 0xffe9;
const KEY_ESCAPE = 0xff1b;
const KEY_3 = 0x33;
const ARM_SETTLE = 60;
const OUT = GLib.getenv('DTW_OUT');
const SCENARIO = GLib.getenv('DTW_SCENARIO') ?? 'single';
const CLIENT = GLib.getenv('DTW_CLIENT');
const ONLY = GLib.getenv('DTW_ONLY');

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

// The driver runs on every version, so unlike the extension it checks at runtime.
const isMax = win => (win.is_maximized ? win.is_maximized() : win.get_maximized() === Meta.MaximizeFlags.BOTH);
const maxFlags = win => (win.get_maximize_flags ? win.get_maximize_flags() : win.get_maximized());
const setMax = win => (win.get_maximized ? win.maximize(Meta.MaximizeFlags.BOTH) : win.maximize());
const clearMax = win => (win.get_maximized ? win.unmaximize(Meta.MaximizeFlags.BOTH) : win.unmaximize());

function variantFor(value) {
    if (typeof value === 'boolean')
        return GLib.Variant.new_boolean(value);
    if (typeof value === 'number')
        return GLib.Variant.new_int32(value);
    return GLib.Variant.new_string(value);
}

function check(condition, message) {
    if (!condition)
        throw new Failure(message);
}

function sameRect(a, b, slack = 2) {
    return ['x', 'y', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) <= slack);
}

export default class DriverExtension extends Extension {
    enable() {
        // Disabling Drag to Workspace in a test makes the shell cycle extensions enabled after it.
        if (globalThis.__dragToWorkspaceDriverStarted)
            return;
        globalThis.__dragToWorkspaceDriverStarted = true;

        const seat = (Clutter.get_default_backend?.() ?? global.stage.get_context().get_backend()).get_default_seat();
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._touch = seat.create_virtual_device(Clutter.InputDeviceType.TOUCHSCREEN_DEVICE);
        this._touchAt = null;
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

    _rightButton(pressed) {
        this._pointer.notify_button(now(), Clutter.BUTTON_SECONDARY,
            pressed ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED);
    }

    /** A right-click during a drag, with the left button still held afterwards. */
    async _rightClick() {
        this._rightButton(true);
        await sleep(40);
        this._rightButton(false);
        await sleep(100);
    }

    _touchDown(x, y) {
        this._touch.notify_touch_down(now(), 0, x, y);
        this._touchAt = [x, y];
    }

    async _touchMoveTo(x, y, {steps = 12, stepMs = 8} = {}) {
        const [sx, sy] = this._touchAt;
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            this._touch.notify_touch_motion(now(), 0, sx + (x - sx) * t, sy + (y - sy) * t);
            await sleep(stepMs);
        }
        this._touchAt = [x, y];
    }

    _touchUp() {
        if (!this._touchAt)
            return;
        this._touch.notify_touch_up(now(), 0);
        this._touchAt = null;
    }

    /** Puts a finger on the header bar and pulls until Mutter has started the move. */
    async _grabByTouch(win) {
        const r = win.get_frame_rect();
        const x = r.x + r.width / 2;
        const y = r.y + 22;
        this._grabs = [];
        this._touchDown(x, y);
        await sleep(100);
        for (let i = 1; i <= 12 && this._grabs.length === 0; i++) {
            await this._touchMoveTo(x, y + i * 4, {steps: 2});
            await sleep(30);
        }
        check(this._grabs.length > 0, 'the touch drag never started a grab');
        await sleep(40);
    }

    async _clickActor(actor) {
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        await this._moveTo(x + width / 2, y + height / 2);
        await sleep(120);
        this._button(true);
        await sleep(40);
        this._button(false);
        await sleep(150);
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

    _spawn(...titles) {
        GLib.spawn_async(null, ['gjs', '-m', CLIENT, ...titles], null, GLib.SpawnFlags.SEARCH_PATH, null);
    }

    /** Runs fn with two windows, E and F, of one installed app, then closes them. */
    async _withAppWindows(fn) {
        this._spawn('E', 'F');
        const e = await this._waitWindow('E');
        const f = await this._waitWindow('F');
        await sleep(500);
        e.move_resize_frame(false, 300, 200, 640, 420);
        f.move_resize_frame(false, 700, 300, 640, 420);
        await sleep(300);
        try {
            await fn(e, f);
        } finally {
            e.delete(global.get_current_time());
            f.delete(global.get_current_time());
            await sleep(500);
        }
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
        this._touchUp();
        manager().get_workspace_by_index(0).activate(global.get_current_time());
        // Moving a window onto a workspace mid-animation trips a bug in the shell's
        // workspaceAnimation.js (_syncStacking), so let the switch finish first.
        await sleep(600);
        const place = [[120, 120], [860, 420], [400, 300], [500, 150]];
        ['A', 'B', 'C', 'D'].forEach((title, i) => {
            const win = this._find(title);
            if (!win)
                return;
            if (maxFlags(win) !== 0)
                clearMax(win);
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
        if (ONLY && !name.includes(ONLY))
            return;
        const started = Date.now();
        console.log(`[drag-to-workspace-driver] TEST ${name}`);
        try {
            await this._reset();
            console.log('[drag-to-workspace-driver] RESET DONE');
            await fn();
            this._results.push({name, ok: true, ms: Date.now() - started});
        } catch (e) {
            this._results.push({name, ok: false, message: `${e.message}${e instanceof Failure ? '' : `\n${e.stack}`}`});
            this._button(false);
            await sleep(200);
        }
    }

    /** Runs fn with settings changed, then puts them back to their defaults. */
    async _withSettings(toss, values, fn) {
        const settings = toss.stateObj.getSettings();
        for (const [key, value] of Object.entries(values))
            settings.set_value(key, value instanceof GLib.Variant ? value : variantFor(value));
        await sleep(100);
        try {
            await fn();
        } finally {
            for (const key of Object.keys(values))
                settings.reset(key);
            await sleep(100);
        }
    }

    async _singleMonitorTests(toss) {
        // The popup after a move is off by default, and several tests click its buttons.
        toss.stateObj.getSettings().set_boolean('show-confirmation', true);
        // Most tests drop at the edge expecting to stay, which with the split gesture would
        // go with the window. The split has its own tests.
        toss.stateObj.getSettings().set_string('picker-gesture', 'hold');
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
            check(maxFlags(a) === 0, 'A was left tiled');
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

        await this._test('Shift means nothing to Drag to Workspace: the throw still lands, and you stay', async () => {
            const a = this._find('A');
            const before = rectOf(a);
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(ARM_SETTLE);
            this._key(KEY_SHIFT, true);
            await sleep(40);
            await this._moveTo(RIGHT, 310, {steps: 3});
            await this._drop();
            this._key(KEY_SHIFT, false);
            await sleep(300);
            check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
            check(activeIndex() === 0, `active is ${activeIndex()}`);
            check(maxFlags(a) === 0, 'A was left tiled');
            check(sameRect(rectOf(a), before), `rect ${JSON.stringify(rectOf(a))} vs ${JSON.stringify(before)}`);
        });

        await this._test('Alt swaps instead when chosen, and Ctrl then does nothing', async () => {
            await this._withSettings(toss, {'follow-modifier': 'alt'}, async () => {
                const a = this._find('A');
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT, 300);
                await sleep(ARM_SETTLE);
                this._key(KEY_CONTROL, true);
                await sleep(40);
                check(!session().willFollow(false), 'should still be staying');
                await this._drop();
                this._key(KEY_CONTROL, false);
                await sleep(300);
                check(activeIndex() === 0, `Ctrl took us to ${activeIndex()}`);
            });
            await this._reset();
            await this._withSettings(toss, {'follow-modifier': 'alt'}, async () => {
                const a = this._find('A');
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT, 300);
                await sleep(ARM_SETTLE);
                this._key(KEY_ALT, true);
                await sleep(40);
                await this._drop();
                this._key(KEY_ALT, false);
                await sleep(500);
                check(activeIndex() === 1, `active is ${activeIndex()}`);
            });
        });

        await this._test('the modifier can be turned off', async () => {
            await this._withSettings(toss, {'follow-modifier': 'none'}, async () => {
                const a = this._find('A');
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT, 300);
                await sleep(ARM_SETTLE);
                this._key(KEY_CONTROL, true);
                await sleep(40);
                await this._drop();
                this._key(KEY_CONTROL, false);
                await sleep(300);
                check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
                check(activeIndex() === 0, `active is ${activeIndex()}`);
            });
        });

        await this._test('quick drop with Ctrl goes with the window', async () => {
            const a = this._find('A');
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(ARM_SETTLE);
            this._key(KEY_CONTROL, true);
            await sleep(40);
            await this._drop();
            this._key(KEY_CONTROL, false);
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

        await this._test('new workspace on the left, with Ctrl: goes there', async () => {
            const a = this._find('A');
            const b = this._find('B');
            await this._grabTitlebar(a);
            await this._moveTo(0, 300);
            await sleep(ARM_SETTLE);
            this._key(KEY_CONTROL, true);
            await sleep(40);
            await this._drop();
            this._key(KEY_CONTROL, false);
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
            const overlay = () => toss.stateObj._overlay;
            const card = () => overlay()._cards[session().selected];
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(450);
            check(session().phase === 'picker', `phase was ${session().phase}`);
            await sleep(1300);
            check(session().willFollow(false), 'should be following after the dwell');
            check(card()._fill.scale_x === 1, `fill at ${card()._fill.scale_x}`);
            check(card()._caption.text === 'Go with it', `caption ${card()._caption.text}`);
            await this._shot('04-picker-follow');
            await this._drop();
            await sleep(500);
            check(activeIndex() === 1, `active is ${activeIndex()}`);
            check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
        });

        await this._test('the card visibly fills up on the way to going with it', async () => {
            // Slow enough for the screenshot to land mid-fill.
            await this._withSettings(toss, {'follow-delay-ms': 3000}, async () => {
                const a = this._find('A');
                const card = () => toss.stateObj._overlay._cards[session().selected];
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT, 300);
                await sleep(450);
                check(session().phase === 'picker', `phase was ${session().phase}`);
                check(card()._caption.text === 'Send here', `caption ${card()._caption.text}`);

                const samples = [];
                for (let i = 0; i < 4; i++) {
                    await sleep(350);
                    samples.push(card()._fill.scale_x);
                }
                check(samples.every((v, i) => i === 0 || v > samples[i - 1]), `fill didn't grow: ${samples}`);
                check(samples[3] > 0.2 && samples[3] < 0.8, `fill at ${samples[3]}`);
                check(!session().willFollow(false), 'flipped before the card was full');
                check(card()._caption.text === 'Hold to go with it', `caption ${card()._caption.text}`);
                await this._shot('04a-picker-filling');

                // Moving to another card starts again from nothing.
                const next = session().layout.rects[1] ?? session().layout.rects[0];
                if (session().layout.rects.length > 1) {
                    const was = session().followProgress;
                    await this._moveTo(RIGHT, next.y + next.height / 2);
                    await sleep(60);
                    check(session().followProgress < was, 'moving did not reset the fill');
                }
                await this._moveTo(800, 500);
                await this._drop();
            });
        });

        await this._test('holding Ctrl over the picker shows the swap straight away', async () => {
            const a = this._find('A');
            const card = () => toss.stateObj._overlay._cards[session().selected];
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(420);
            check(session().phase === 'picker', `phase was ${session().phase}`);
            this._key(KEY_CONTROL, true);
            await sleep(80);
            check(card()._caption.text === 'Go with it', `caption ${card()._caption.text}`);
            check(card()._fill.scale_x === 1, `fill at ${card()._fill.scale_x}`);
            this._key(KEY_CONTROL, false);
            await sleep(80);
            check(card()._caption.text !== 'Go with it', 'did not swap back on release');
            await this._moveTo(800, 500);
            await this._drop();
        });

        await this._test('right-click on a card throws right away, and the view follows on letting go', async () => {
            await this._spreadWorkspaces(['A', 'B', 'C']);
            manager().get_workspace_by_index(0).activate(global.get_current_time());
            await sleep(500);
            const d = this._find('D');
            d.activate(global.get_current_time());
            await sleep(150);
            const windowsBefore = global.display.list_all_windows().length;
            await this._grabTitlebar(d);
            await this._moveTo(RIGHT, 300);
            await sleep(450);
            check(session().phase === 'picker', `phase was ${session().phase}`);
            const rect = session().layout.rects[1];
            await this._moveTo(RIGHT, rect.y + rect.height / 2);
            await sleep(100);
            check(session().selected === 1, `selected ${session().selected}`);
            check(session().followProgress < 1, 'the card had already filled');

            this._slides = 0;
            await this._rightClick();
            await sleep(300);
            check(d.get_workspace().index() === 2, `D on ${d.get_workspace().index()}`);
            check(!toss.stateObj._drag, 'the drag session is still alive');
            check(!toss.stateObj._overlay._picker, 'picker still up');
            check(!maxFlags(d), 'D was left tiled');
            // A slide with the left button down is what can abort the shell.
            check(activeIndex() === 0, `switched with the button down, active is ${activeIndex()}`);
            check(this._slides === 0, `played ${this._slides} slides with the button down`);

            // Letting go switches, and lands on nothing: no menu, no focus change.
            this._button(false);
            await sleep(600);
            check(activeIndex() === 2, `active is ${activeIndex()}`);
            check(global.display.list_all_windows().length === windowsBefore, 'a menu or window appeared');
            check(!global.stage.get_grab_actor(), 'something is holding a grab, like the desktop menu');
            check(global.display.focus_window === d, `focus is ${global.display.focus_window?.get_title()}`);
            check(d.get_workspace().index() === 2, `D moved again to ${d.get_workspace().index()}`);
        });

        await this._test('right-click before the picker opens goes to the next workspace', async () => {
            await this._withSettings(toss, {'hold-delay-ms': 1500}, async () => {
                const a = this._find('A');
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT, 300);
                await sleep(ARM_SETTLE);
                check(session().phase === 'armed', `phase was ${session().phase}`);
                await this._rightClick();
                await sleep(200);
                check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
                check(activeIndex() === 0, `active is ${activeIndex()} with the button down`);
                this._button(false);
                await sleep(600);
                check(activeIndex() === 1, `active is ${activeIndex()}`);
            });
        });

        await this._test('right-click still goes along when a normal drop already does', async () => {
            await this._withSettings(toss, {'drop-action': 'follow'}, async () => {
                const a = this._find('A');
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT, 300);
                await sleep(ARM_SETTLE);
                await this._rightClick();
                await sleep(200);
                this._button(false);
                await sleep(600);
                check(activeIndex() === 1, `active is ${activeIndex()}`);
            });
        });

        await this._test('letting go of left before right still waits for both', async () => {
            const a = this._find('A');
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(ARM_SETTLE);
            this._rightButton(true);
            await sleep(200);
            this._button(false);
            await sleep(200);
            check(activeIndex() === 0, `switched with right held, active is ${activeIndex()}`);
            this._rightButton(false);
            await sleep(600);
            check(activeIndex() === 1, `active is ${activeIndex()}`);
        });

        await this._test('stress: 30 right-click throws at varied timings do not bring the shell down', async () => {
            // The abort this guards against depends on timing, and the first version of
            // right-click hit it within three throws. A crash here means no results at all.
            const a = this._find('A');
            for (let i = 0; i < 30; i++) {
                await this._reset();
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT, 300, {steps: 6, stepMs: 4});
                await sleep([10, 60, 150, 400][i % 4]);
                this._rightButton(true);
                await sleep([0, 15, 40][i % 3]);
                this._rightButton(false);
                await sleep([0, 5, 30, 200][(i >> 1) % 4]);
                this._button(false);
                await sleep(450);
                check(a.get_workspace().index() === 1, `round ${i}: A on ${a.get_workspace().index()}`);
                check(activeIndex() === 1, `round ${i}: active is ${activeIndex()}`);
                check(!global.stage.get_grab_actor(), `round ${i}: a grab was left behind`);
            }
        });

        await this._test('closing the window before letting go cancels the switch', async () => {
            const a = this._find('A');
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(ARM_SETTLE);
            await this._rightClick();
            await sleep(200);
            check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
            a.delete(global.get_current_time());
            await sleep(400);
            this._button(false);
            await sleep(500);
            check(activeIndex() === 0, `active is ${activeIndex()}`);
            this._spawn('A');
            await this._waitWindow('A');
            await sleep(500);
        });

        await this._test('right-click turned off: it is a plain drop, and you stay', async () => {
            await this._withSettings(toss, {'right-click-to-go': false}, async () => {
                const a = this._find('A');
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT, 300);
                await sleep(ARM_SETTLE);
                await this._rightClick();
                await sleep(300);
                this._button(false);
                await sleep(200);
                check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
                check(activeIndex() === 0, `active is ${activeIndex()}`);
            });
        });

        await this._test('a middle-click is a plain drop, not a right-click', async () => {
            const a = this._find('A');
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(ARM_SETTLE);
            this._pointer.notify_button(now(), Clutter.BUTTON_MIDDLE, Clutter.ButtonState.PRESSED);
            await sleep(40);
            this._pointer.notify_button(now(), Clutter.BUTTON_MIDDLE, Clutter.ButtonState.RELEASED);
            await sleep(200);
            this._button(false);
            await sleep(500);
            check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
            check(activeIndex() === 0, `active is ${activeIndex()}`);
        });

        await this._test('right-click away from the edge just ends the drag', async () => {
            const a = this._find('A');
            await this._grabTitlebar(a);
            await this._moveTo(800, 500);
            await sleep(80);
            await this._rightClick();
            await sleep(300);
            this._button(false);
            await sleep(200);
            check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
            check(activeIndex() === 0, `active is ${activeIndex()}`);
        });

        await this._test('touch: a quick drop moves the window', async () => {
            const a = this._find('A');
            const before = rectOf(a);
            await this._grabByTouch(a);
            await this._touchMoveTo(RIGHT, 300);
            await sleep(ARM_SETTLE);
            check(session().phase === 'armed', `phase was ${session().phase}`);
            this._touchUp();
            await sleep(400);
            check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
            check(activeIndex() === 0, `active is ${activeIndex()}`);
            check(maxFlags(a) === 0, 'A was left tiled');

            // A hidden window doesn't redraw, so on older versions its size only settles once
            // it's visible again. What counts is how it looks when you go there.
            manager().get_workspace_by_index(1).activate(global.get_current_time());
            await sleep(800);
            check(sameRect(rectOf(a), before), `rect ${JSON.stringify(rectOf(a))} vs ${JSON.stringify(before)}`);
            await this._shot('35-touch-window-after-visiting');
        });

        await this._test('touch: holding opens the picker, and a card can be chosen', async () => {
            await this._spreadWorkspaces(['A', 'B', 'C']);
            manager().get_workspace_by_index(0).activate(global.get_current_time());
            await sleep(500);
            const d = this._find('D');
            d.activate(global.get_current_time());
            await sleep(150);
            await this._grabByTouch(d);
            await this._touchMoveTo(RIGHT, 300);
            await sleep(450);
            check(session().phase === 'picker', `phase was ${session().phase}`);
            const rect = session().layout.rects[1];
            await this._touchMoveTo(RIGHT, rect.y + rect.height / 2);
            await sleep(100);
            check(session().selected === 1, `selected ${session().selected}`);
            this._touchUp();
            await sleep(400);
            check(d.get_workspace().index() === 2, `D on ${d.get_workspace().index()}`);
            check(activeIndex() === 0, `active is ${activeIndex()}`);
        });

        await this._test('touch: holding on a card goes with the window, repeatedly without a crash', async () => {
            const a = this._find('A');
            for (let i = 0; i < 5; i++) {
                await this._reset();
                await this._grabByTouch(a);
                await this._touchMoveTo(RIGHT, 300);
                await sleep(1750);
                check(session().willFollow(false), `round ${i}: not following yet`);
                this._touchUp();
                await sleep(600);
                check(activeIndex() === 1, `round ${i}: active is ${activeIndex()}`);
                check(!global.stage.get_grab_actor(), `round ${i}: a grab was left behind`);
            }
        });

        await this._test('touch: the mouse sitting at the edge has no say', async () => {
            await this._moveTo(RIGHT, 300);
            await sleep(100);
            const a = this._find('A');
            await this._grabByTouch(a);
            await this._touchMoveTo(800, 500);
            await sleep(450);
            check(session().phase === 'idle', `phase was ${session().phase}`);
            this._touchUp();
            await sleep(300);
            check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
            await this._moveTo(800, 700);
        });

        await this._test('touch: a second finger at the edge is ignored', async () => {
            const a = this._find('A');
            await this._grabByTouch(a);
            await this._touchMoveTo(800, 500);
            await sleep(60);
            this._touch.notify_touch_down(now(), 1, RIGHT, 300);
            await sleep(40);
            this._touch.notify_touch_motion(now(), 1, RIGHT, 310);
            await sleep(300);
            check(session()?.phase === 'idle', `phase was ${session()?.phase}`);
            this._touch.notify_touch_up(now(), 1);
            await sleep(60);
            this._touchUp();
            await sleep(300);
            check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
        });

        await this._test('Undo puts the window back where it was', async () => {
            const a = this._find('A');
            const before = rectOf(a);
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(ARM_SETTLE);
            await this._drop();
            await sleep(100);
            const popup = toss.stateObj._overlay._popup;
            check(popup, 'no popup after the move');
            check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
            await this._shot('30-undo-go-popup');

            await this._clickActor(popup.get_children()[1]);
            await sleep(300);
            check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()} after Undo`);
            check(activeIndex() === 0, `active is ${activeIndex()}`);
            check(sameRect(rectOf(a), before), `rect ${JSON.stringify(rectOf(a))} vs ${JSON.stringify(before)}`);
            check(global.display.focus_window === a, `focus is ${global.display.focus_window?.get_title()}`);
            check(!toss.stateObj._overlay._popup, 'popup still up after Undo');
        });

        await this._test('Go takes you to the window', async () => {
            const a = this._find('A');
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(ARM_SETTLE);
            await this._drop();
            await sleep(100);
            await this._clickActor(toss.stateObj._overlay._popup.get_children()[2]);
            await sleep(600);
            check(activeIndex() === 1, `active is ${activeIndex()}`);
            check(global.display.focus_window === a, `focus is ${global.display.focus_window?.get_title()}`);
            check(!global.stage.get_grab_actor(), 'a grab was left behind');
        });

        await this._test('the popup goes away by itself, but not while the pointer is on it', async () => {
            const overlay = toss.stateObj._overlay;
            const a = this._find('A');
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(ARM_SETTLE);
            await this._drop();
            await sleep(100);
            const [x, y] = overlay._popup.get_transformed_position();
            await this._moveTo(x + 10, y + 10);
            await sleep(4500);
            check(overlay._popup, 'popup closed under the pointer');
            await this._moveTo(800, 700);
            await sleep(4500);
            check(!overlay._popup, 'popup never closed');
        });

        await this._test('the popup is above the pointer, not under it', async () => {
            const overlay = toss.stateObj._overlay;
            const a = this._find('A');
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 500);
            await sleep(ARM_SETTLE);
            await this._drop();
            await sleep(100);
            const [, y] = overlay._popup.get_transformed_position();
            const [, height] = overlay._popup.get_transformed_size();
            check(y + height < 500, `popup ends at ${y + height}`);
        });

        await this._test('top edge: a quick drop still maximizes', async () => {
            const a = this._find('A');
            await this._grabTitlebar(a);
            await this._moveTo(800, 10);
            await sleep(250);
            check(session().phase === 'armed' && session().kind === 'top', `phase was ${session().phase}`);
            check(!session().decide(), 'a quick drop would move the window');
            await this._drop();
            await sleep(400);
            check(isMax(a), 'A did not maximize');
            check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
        });

        await this._test('top edge: dropping on the open picker without choosing still maximizes', async () => {
            const a = this._find('A');
            await this._grabTitlebar(a);
            await this._moveTo(800, 10);
            await sleep(800);
            check(session().phase === 'picker', `phase was ${session().phase}`);
            check(session().selected === -1, `selected ${session().selected}`);
            await this._drop();
            await sleep(400);
            check(isMax(a), 'A did not maximize');
            check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
        });

        await this._test('top edge: shows workspaces on both sides, and a card can be chosen', async () => {
            await this._spreadWorkspaces(['A', 'B', 'C']);
            manager().get_workspace_by_index(1).activate(global.get_current_time());
            await sleep(600);
            const b = this._find('B');
            this._find('D').change_workspace_by_index(1, true);
            b.activate(global.get_current_time());
            await sleep(200);
            const before = rectOf(b);
            await this._grabTitlebar(b);
            await this._moveTo(800, 10);
            await sleep(800);
            check(session().phase === 'picker', `phase was ${session().phase}`);
            check(session().targets.map(t => t.index).join() === '0,2,3', `targets ${session().targets.map(t => t.index)}`);
            const first = session().layout.rects[0];
            await this._moveTo(first.x + first.width / 2, 10);
            await sleep(100);
            check(session().selected === 0, `selected ${session().selected}`);
            const stripBadge = toss.stateObj._overlay._cards[0]._badge;
            check(stripBadge.width >= 10, `badge is ${stripBadge.width} wide`);
            await this._shot('31-top-edge-strip');
            await this._drop();
            await sleep(400);
            check(b.get_workspace().index() === 0, `B on ${b.get_workspace().index()}`);
            check(activeIndex() === 1, `active is ${activeIndex()}`);
            check(!isMax(b), 'B was left maximized');
            check(sameRect(rectOf(b), before), `rect ${JSON.stringify(rectOf(b))} vs ${JSON.stringify(before)}`);
        });

        await this._test('top edge can be turned off', async () => {
            await this._withSettings(toss, {'top-edge': false}, async () => {
                const a = this._find('A');
                await this._grabTitlebar(a);
                await this._moveTo(800, 10);
                await sleep(800);
                check(session().phase === 'idle', `phase was ${session().phase}`);
                await this._drop();
                await sleep(300);
                check(isMax(a), 'A did not maximize');
            });
        });

        await this._test('number key: choose a workspace mid-screen, then drop', async () => {
            await this._spreadWorkspaces(['A', 'B', 'C']);
            manager().get_workspace_by_index(0).activate(global.get_current_time());
            await sleep(500);
            const d = this._find('D');
            d.activate(global.get_current_time());
            await sleep(150);
            const before = rectOf(d);
            await this._grabTitlebar(d);
            await this._moveTo(800, 500);
            this._key(KEY_3, true);
            this._key(KEY_3, false);
            await sleep(120);
            check(session().keyTarget?.index === 2, `key target ${session().keyTarget?.index}`);
            await this._shot('32-number-key');
            await this._drop();
            await sleep(300);
            check(d.get_workspace().index() === 2, `D on ${d.get_workspace().index()}`);
            check(activeIndex() === 0, `active is ${activeIndex()}`);
            check(sameRect(rectOf(d), before), `rect ${JSON.stringify(rectOf(d))} vs ${JSON.stringify(before)}`);
        });

        await this._test('number key: pressing it again cancels, and a missing one does nothing', async () => {
            await this._spreadWorkspaces(['A', 'B', 'C']);
            manager().get_workspace_by_index(0).activate(global.get_current_time());
            await sleep(500);
            const d = this._find('D');
            d.activate(global.get_current_time());
            await sleep(150);
            await this._grabTitlebar(d);
            await this._moveTo(800, 500);
            this._key(KEY_3, true);
            this._key(KEY_3, false);
            await sleep(60);
            check(session().keyTarget?.index === 2, 'not chosen');
            this._key(KEY_3, true);
            this._key(KEY_3, false);
            await sleep(60);
            check(!session().keyTarget, 'not cancelled');
            this._key(0x39, true);
            this._key(0x39, false);
            await sleep(60);
            check(!session().keyTarget, 'chose a workspace that does not exist');
            await this._drop();
            check(d.get_workspace().index() === 0, `D on ${d.get_workspace().index()}`);
        });

        await this._test('number key can be turned off', async () => {
            await this._withSettings(toss, {'number-keys': false}, async () => {
                const a = this._find('A');
                await this._grabTitlebar(a);
                await this._moveTo(800, 500);
                this._key(0x32, true);
                this._key(0x32, false);
                await sleep(60);
                check(!session().keyTarget, 'chose a workspace while off');
                await this._drop();
                check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
            });
        });

        await this._test('all of an app\'s windows: moved together, and Undo brings them all back', async () => {
            await this._withAppWindows(async (e, f) => {
                e.activate(global.get_current_time());
                await sleep(150);
                await this._grabTitlebar(e);
                await this._moveTo(RIGHT, 300);
                await sleep(ARM_SETTLE);
                this._key(KEY_ALT, true);
                await sleep(60);
                check(toss.stateObj._overlay._tabLabel.text.includes('All windows'), toss.stateObj._overlay._tabLabel.text);
                await this._shot('33-all-windows');
                await this._drop();
                this._key(KEY_ALT, false);
                await sleep(300);
                check(e.get_workspace().index() === 1, `E on ${e.get_workspace().index()}`);
                check(f.get_workspace().index() === 1, `F on ${f.get_workspace().index()}`);
                check(this._find('A').get_workspace().index() === 0, 'A moved too');
                check(activeIndex() === 0, `active is ${activeIndex()}`);

                await this._clickActor(toss.stateObj._overlay._popup.get_children()[1]);
                await sleep(300);
                check(e.get_workspace().index() === 0, `E on ${e.get_workspace().index()} after Undo`);
                check(f.get_workspace().index() === 0, `F on ${f.get_workspace().index()} after Undo`);
            });
        });

        await this._test('without the key, only the dragged window moves', async () => {
            await this._withAppWindows(async (e, f) => {
                e.activate(global.get_current_time());
                await sleep(150);
                await this._grabTitlebar(e);
                await this._moveTo(RIGHT, 300);
                await sleep(ARM_SETTLE);
                await this._drop();
                await sleep(300);
                check(e.get_workspace().index() === 1, `E on ${e.get_workspace().index()}`);
                check(f.get_workspace().index() === 0, `F on ${f.get_workspace().index()}`);
            });
        });

        await this._test('an excluded app is left alone, and others still move', async () => {
            await this._withSettings(toss, {
                'excluded-apps': new GLib.Variant('as', ['dev.dragtoworkspace.Client.E.desktop']),
            }, async () => {
                await this._withAppWindows(async e => {
                    e.activate(global.get_current_time());
                    await sleep(150);
                    await this._grabTitlebar(e);
                    check(!session(), 'a session started for an excluded app');
                    await this._moveTo(RIGHT, 300);
                    await sleep(450);
                    check(Main.wm._tilePreview?.visible, 'no tile preview');
                    await this._moveTo(800, 500);
                    await this._drop();
                    check(e.get_workspace().index() === 0, `E on ${e.get_workspace().index()}`);

                    const a = this._find('A');
                    a.activate(global.get_current_time());
                    await sleep(150);
                    await this._grabTitlebar(a);
                    check(session(), 'no session for an app that is not excluded');
                    await this._moveTo(800, 500);
                    await this._drop();
                });
            });
        });

        await this._test('cards show workspace names and app icons', async () => {
            const wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
            wm.set_strv('workspace-names', ['Home', 'Code']);
            await sleep(200);
            try {
                await this._withAppWindows(async e => {
                    e.change_workspace_by_index(1, true);
                    this._find('F').change_workspace_by_index(1, true);
                    await sleep(300);
                    const a = this._find('A');
                    a.activate(global.get_current_time());
                    await sleep(150);
                    await this._grabTitlebar(a);
                    await this._moveTo(RIGHT, 300);
                    await sleep(500);
                    check(session().phase === 'picker', `phase was ${session().phase}`);
                    const card = toss.stateObj._overlay._cards[0];
                    check(card._badge.text.includes('Code'), `badge says ${card._badge.text}`);
                    check(card._icons?.get_n_children() === 1, `icons ${card._icons?.get_n_children()}`);
                    // Sizes on screen, as the text alone says nothing about being cut off.
                    const [badgeNatural] = card._badge.clutter_text.get_preferred_width(-1).slice(1);
                    check(card._badge.width >= badgeNatural - 1, `badge cut to ${card._badge.width} of ${badgeNatural}`);
                    const [iconsX] = card._icons.get_transformed_position();
                    const [cardX] = card.get_transformed_position();
                    check(iconsX + card._icons.width <= cardX + card.width, 'icons overflow the card');
                    await this._shot('34-names-and-icons');
                    await this._moveTo(800, 500);
                    await this._drop();
                });
            } finally {
                wm.reset('workspace-names');
            }
        });

        await this._test('names and icons can be turned off', async () => {
            await this._withSettings(toss, {'show-app-icons': false, 'show-workspace-names': false}, async () => {
                const wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
                wm.set_strv('workspace-names', ['Home', 'Code']);
                await sleep(200);
                try {
                    const a = this._find('A');
                    await this._grabTitlebar(a);
                    await this._moveTo(RIGHT, 300);
                    await sleep(500);
                    const card = toss.stateObj._overlay._cards[0];
                    check(!card._badge.text.includes('Code'), `badge says ${card._badge.text}`);
                    check(!card._icons, 'icons showed');
                    await this._moveTo(800, 500);
                    await this._drop();
                } finally {
                    wm.reset('workspace-names');
                }
            });
        });

        await this._test('vertical workspaces: the arrows point up and down', async () => {
            manager().override_workspace_layout(Meta.DisplayCorner.TOPLEFT, false, -1, 1);
            await sleep(100);
            try {
                await this._withSettings(toss, {'hold-delay-ms': 1500}, async () => {
                    const a = this._find('A');
                    await this._grabTitlebar(a);
                    await this._moveTo(RIGHT, 300);
                    await sleep(ARM_SETTLE);
                    const text = toss.stateObj._overlay._tabLabel.text;
                    check(text.includes('↓'), `tab says ${text}`);
                    await this._moveTo(800, 500);
                    await this._drop();
                });
            } finally {
                manager().override_workspace_layout(Meta.DisplayCorner.TOPLEFT, false, 1, -1);
            }
        });

        await this._test('split: at the edge the picker sends, further in it goes with the window', async () => {
            await this._withSettings(toss, {'picker-gesture': 'split'}, async () => {
                await this._spreadWorkspaces(['A', 'B', 'C']);
                manager().get_workspace_by_index(0).activate(global.get_current_time());
                await sleep(500);
                const d = this._find('D');
                d.activate(global.get_current_time());
                await sleep(150);
                const card = () => toss.stateObj._overlay._cards[session().selected];
                const active = () => Object.entries(card()._parts)
                    .find(([, part]) => part.has_style_pseudo_class('checked'))?.[0];
                await this._grabTitlebar(d);
                await this._moveTo(RIGHT, 300);
                await sleep(450);
                check(session().phase === 'picker', `phase was ${session().phase}`);
                check(!session().inOppositePart, 'the pointer at the edge does the opposite');
                check(active() === 'outer', `active part ${active()}`);
                check(card()._parts.outer.child.text === 'Send here', `outer says ${card()._parts.outer.child.text}`);
                check(card()._parts.inner.child.text === 'Go with it', `inner says ${card()._parts.inner.child.text}`);
                await this._shot('36-split-at-edge');

                const inner = RIGHT - 6 - session().layout.cardWidth + 20;
                await this._moveTo(inner, 300);
                await sleep(80);
                check(session().inOppositePart, 'not on the inner part');
                check(active() === 'inner', `active part ${active()}`);
                await this._shot('37-split-inner');
                await sleep(2000);
                check(session().willFollow(false), 'no longer going with the window');
                await this._drop();
                await sleep(600);
                check(d.get_workspace().index() === 1, `D on ${d.get_workspace().index()}`);
                check(activeIndex() === 1, `active is ${activeIndex()}`);
            });
        });

        await this._test('split: dropping at the edge just sends', async () => {
            await this._withSettings(toss, {'picker-gesture': 'split'}, async () => {
                const a = this._find('A');
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT, 300);
                await sleep(450);
                check(!session().inOppositePart, 'on the inner part');
                await this._drop();
                await sleep(400);
                check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
                check(activeIndex() === 0, `active is ${activeIndex()}`);
            });
        });

        await this._test('picker gesture off: a long hold still just sends', async () => {
            await this._withSettings(toss, {'picker-gesture': 'off', 'follow-delay-ms': 400}, async () => {
                const a = this._find('A');
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT, 300);
                await sleep(1000);
                check(session().phase === 'picker', `phase was ${session().phase}`);
                check(!session().willFollow(false), 'followed anyway');
                await this._drop();
                await sleep(300);
                check(activeIndex() === 0, `active is ${activeIndex()}`);
                check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
            });
        });

        await this._test('drop-action follow: a drop goes along, and the hold fills towards staying', async () => {
            await this._withSettings(toss, {'drop-action': 'follow', 'follow-delay-ms': 2000}, async () => {
                const a = this._find('A');
                const card = () => toss.stateObj._overlay._cards[session().selected];
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT, 300);
                await sleep(420);
                check(card()._caption.text === 'Go with it', `caption ${card()._caption.text}`);
                await sleep(700);
                check(card()._caption.text === 'Hold to stay here', `caption ${card()._caption.text}`);
                await this._moveTo(800, 500);
                await this._moveTo(RIGHT, 300);
                await sleep(ARM_SETTLE);
                await this._drop();
                await sleep(500);
                check(activeIndex() === 1, `active is ${activeIndex()}`);
            });
        });

        await this._test('a custom area: only that stretch of the edge throws, and the hint matches', async () => {
            const settings = {
                'right-zone-start': 40, 'right-zone-end': 60,
                'left-zone-start': 40, 'left-zone-end': 60,
            };
            await this._withSettings(toss, settings, async () => {
                const a = this._find('A');
                const hintActor = toss.stateObj._overlay._hint;
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT - 120, 500);
                await sleep(60);
                const wa = Main.layoutManager.getWorkAreaForMonitor(0);
                check(Math.abs(hintActor.y - (wa.y + wa.height * 0.4)) <= 1, `hint at y=${hintActor.y}`);
                check(Math.abs(hintActor.height - wa.height * 0.2) <= 1, `hint height ${hintActor.height}`);
                await this._shot('08-custom-area-hint');

                await this._moveTo(RIGHT, wa.y + wa.height * 0.2);
                await sleep(350);
                check(session().phase === 'idle', `above the area: ${session().phase}`);
                check(Main.wm._tilePreview?.visible, 'no tile preview above the area');

                await this._moveTo(RIGHT, wa.y + wa.height * 0.5);
                await sleep(80);
                check(session().phase === 'armed', `inside the area: ${session().phase}`);
                await this._drop();
                await sleep(300);
                check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
                check(maxFlags(a) === 0, 'A was left tiled');
            });
        });

        await this._test('a turned off edge just half-tiles, the other still throws', async () => {
            await this._withSettings(toss, {'right-enabled': false}, async () => {
                const a = this._find('A');
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT - 120, 300);
                await sleep(60);
                check(!session().hint, 'hint on a turned off edge');
                await this._moveTo(RIGHT, 300);
                await sleep(350);
                check(session().phase === 'idle', `phase was ${session().phase}`);
                check(Main.wm._tilePreview?.visible, 'no tile preview');
                await this._moveTo(0, 300, {steps: 30});
                await sleep(ARM_SETTLE);
                check(session().phase === 'armed', `left edge: ${session().phase}`);
                await this._moveTo(800, 500);
                await this._drop();
            });
        });

        await this._test('a small distance leaves a strip that half-tiles before the edge', async () => {
            await this._withSettings(toss, {'edge-depth': 8}, async () => {
                const a = this._find('A');
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT - 30, 300);
                await sleep(350);
                check(session().phase === 'idle', `30px out: ${session().phase}`);
                check(Main.wm._tilePreview?.visible, 'no tile preview 30px out');

                await this._moveTo(RIGHT, 300);
                await sleep(80);
                check(session().phase === 'armed', `at the edge: ${session().phase}`);
                // The preview takes a moment to fade out.
                await sleep(220);
                check(!Main.wm._tilePreview?.visible, 'tile preview still up at the edge');

                await this._moveTo(RIGHT - 30, 300);
                await sleep(350);
                check(Main.wm._tilePreview?.visible, 'tile preview did not come back');
                await this._drop();
                await sleep(300);
                check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
                check(maxFlags(a) !== 0, 'A did not tile');
            });
        });

        await this._test('a large distance throws from further out', async () => {
            await this._withSettings(toss, {'edge-depth': 120}, async () => {
                const a = this._find('A');
                await this._grabTitlebar(a);
                await this._moveTo(RIGHT - 90, 300);
                await sleep(ARM_SETTLE);
                check(session().phase === 'armed', `phase was ${session().phase}`);
                await this._drop();
                await sleep(300);
                check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
            });
        });

        await this._test('new workspaces can be turned off', async () => {
            await this._withSettings(toss, {'offer-new-workspace': false}, async () => {
                const a = this._find('A');
                await this._grabTitlebar(a);
                await this._moveTo(0, 300);
                await sleep(350);
                check(session().phase === 'idle', `phase was ${session().phase}`);
                check(Main.wm._tilePreview?.visible, 'no tile preview');
                await this._moveTo(800, 500);
                await this._drop();
                check(manager().get_n_workspaces() <= 2, 'made a workspace anyway');
            });
        });

        await this._test('the look options are honoured', async () => {
            const looks = {'show-hint': false, 'show-confirmation': false, 'animate-throw': false, 'card-width': 300};
            await this._withSettings(toss, looks, async () => {
                const overlay = toss.stateObj._overlay;
                const calls = {flyOut: 0, showMoved: 0};
                const flyOut = overlay.flyOut;
                const showMoved = overlay.showMoved;
                overlay.flyOut = function (...args) {
                    calls.flyOut++;
                    return flyOut.apply(this, args);
                };
                overlay.showMoved = function (...args) {
                    calls.showMoved++;
                    return showMoved.apply(this, args);
                };
                try {
                    const a = this._find('A');
                    await this._grabTitlebar(a);
                    await this._moveTo(RIGHT - 120, 300);
                    await sleep(60);
                    check(!overlay._hint.visible, 'hint showed while off');
                    await this._moveTo(RIGHT, 300);
                    await sleep(450);
                    check(session().phase === 'picker', `phase was ${session().phase}`);
                    check(session().layout.cardWidth === 300, `card width ${session().layout.cardWidth}`);
                    await this._drop();
                    await sleep(200);
                    check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
                    check(calls.flyOut === 0 && calls.showMoved === 0, `calls ${JSON.stringify(calls)}`);
                } finally {
                    delete overlay.flyOut;
                    delete overlay.showMoved;
                }
            });
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
            check(maxFlags(a) !== 0, 'A did not tile');
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
            check(maxFlags(a) === 0, 'A was left tiled');
            check(sameRect(rectOf(a), before), `rect ${JSON.stringify(rectOf(a))} vs ${JSON.stringify(before)}`);
        });

        await this._test('Escape while a button is pressed too: still a cancel', async () => {
            const a = this._find('A');
            const before = rectOf(a);
            await this._grabTitlebar(a);
            await this._moveTo(RIGHT, 300);
            await sleep(450);
            check(session().phase === 'picker', `phase was ${session().phase}`);
            this._key(KEY_ESCAPE, true);
            this._key(KEY_ESCAPE, false);
            await sleep(100);
            this._rightButton(true);
            await sleep(30);
            this._rightButton(false);
            await sleep(150);
            this._button(false);
            await sleep(300);
            check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
            check(activeIndex() === 0, `active is ${activeIndex()}`);
            check(sameRect(rectOf(a), before), `rect ${JSON.stringify(rectOf(a))} vs ${JSON.stringify(before)}`);

            // The drag is over by then, so that right-click reached the desktop, whose menu
            // is GNOME's own behaviour. Close it for the next test.
            this._key(KEY_ESCAPE, true);
            this._key(KEY_ESCAPE, false);
            await sleep(300);
            check(!global.stage.get_grab_actor(), 'the desktop menu is still open');
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
            setMax(a);
            await sleep(400);
            check(isMax(a), 'A did not maximize');
            await this._grabTitlebar(a, {offsetX: 400});
            await this._moveTo(800, 400);
            await sleep(120);
            check(!isMax(a), 'A did not shake loose');
            await this._moveTo(RIGHT, 300);
            await sleep(ARM_SETTLE);
            await this._drop();
            await sleep(300);
            check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
            check(isMax(a), 'A lost maximize');
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
            check(maxFlags(a) !== 0, 'A did not tile');
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
        toss.stateObj.getSettings().set_string('picker-gesture', 'hold');
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

            await this._test(`${tag}: a quick drop at the edge between monitors moves nothing`, async () => {
                const a = this._find('A');
                place(a, left);
                await sleep(300);
                a.activate(global.get_current_time());
                await sleep(100);
                await this._grabTitlebar(a);
                await this._moveTo(right.x - 1, 300);
                await sleep(450);
                check(!session().decide(), 'a quick drop at the shared edge would move the window');
                check(!toss.stateObj._overlay._picker, 'picker opened too soon at the shared edge');
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

            await this._test(`${tag}: holding at the edge between monitors opens the picker there`, async () => {
                const a = this._find('A');
                place(a, left);
                await sleep(300);
                this._find('B').change_workspace_by_index(0, false);
                a.activate(global.get_current_time());
                await sleep(100);
                const before = rectOf(a);
                await this._grabTitlebar(a);
                await this._moveTo(left.x + left.width - 1, 300);
                await sleep(800);
                check(session().phase === 'picker', `phase was ${session().phase}`);
                check(session().kind === 'shared', `kind was ${session().kind}`);
                check(session().selected === -1, `selected ${session().selected}`);
                await this._shot(`12-shared-edge-${onlyPrimary ? 'primary' : 'all'}`);

                const rect = session().layout.rects[0];
                await this._moveTo(left.x + left.width - 1, rect.y + rect.height / 2 + 20);
                await sleep(100);
                check(session().selected === 0, `selected ${session().selected}`);
                await this._drop();
                await sleep(400);
                check(a.get_workspace().index() === 1, `A on ${a.get_workspace().index()}`);
                check(sameRect(rectOf(a), before), `rect ${JSON.stringify(rectOf(a))} vs ${JSON.stringify(before)}`);
            });

            await this._test(`${tag}: dropping on that picker without choosing moves nothing`, async () => {
                const a = this._find('A');
                place(a, left);
                await sleep(300);
                a.activate(global.get_current_time());
                await sleep(100);
                await this._grabTitlebar(a);
                await this._moveTo(left.x + left.width - 1, 300);
                await sleep(800);
                check(session().phase === 'picker', `phase was ${session().phase}`);
                await this._drop();
                await sleep(300);
                check(a.get_workspace().index() === 0, `A on ${a.get_workspace().index()}`);
                check(activeIndex() === 0, `active is ${activeIndex()}`);
            });

            await this._test(`${tag}: the edge between monitors can be turned off`, async () => {
                await this._withSettings(toss, {'shared-edges': false}, async () => {
                    const a = this._find('A');
                    place(a, left);
                    await sleep(300);
                    a.activate(global.get_current_time());
                    await sleep(100);
                    await this._grabTitlebar(a);
                    await this._moveTo(left.x + left.width - 1, 300);
                    await sleep(800);
                    check(session().phase === 'idle', `phase was ${session().phase}`);
                    await this._moveTo(left.x + 300, 400);
                    await this._drop();
                });
            });

            await this._test(`${tag}: the primary-only setting ignores other monitors' edges`, async () => {
                await this._withSettings(toss, {monitors: 'primary'}, async () => {
                    const a = this._find('A');
                    place(a, primary);
                    await sleep(300);
                    a.activate(global.get_current_time());
                    await sleep(100);
                    await this._grabTitlebar(a);
                    const farRight = primary.x === left.x;
                    const farEdge = farRight ? right.x + right.width - 1 : left.x;
                    await this._moveTo(farEdge, 300, {steps: 24});
                    await sleep(ARM_SETTLE + 40);
                    check(session().phase === 'idle', `on the other monitor: ${session().phase}`);

                    const ownEdge = farRight ? left.x : right.x + right.width - 1;
                    await this._moveTo(ownEdge, 300, {steps: 30});
                    await sleep(ARM_SETTLE + 40);
                    check(session().phase === 'armed', `on the primary: ${session().phase}`);
                    await this._moveTo(primary.x + 300, 500, {steps: 24});
                    await this._drop();
                });
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

    /**
     * The same window activity as the tests, with Drag to Workspace off. A JS error here is the
     * distro's GNOME build, not the extension.
     */
    async _controlRun(toss) {
        await Main.extensionManager.disableExtension(toss.uuid);
        await sleep(300);
        const W = global.display.get_monitor_geometry(0).width;

        await this._test('control: another move during a drag, with Drag to Workspace off', async () => {
            await this._spreadWorkspaces(['A', 'B', 'C']);
            this._find('D').change_workspace_by_index(1, true);
            await sleep(150);
            manager().get_workspace_by_index(1).activate(global.get_current_time());
            await sleep(600);
            const b = this._find('B');
            b.activate(global.get_current_time());
            await sleep(150);
            await this._grabTitlebar(b);
            await this._moveTo(W - 1, 300);
            await sleep(450);
            Main.wm.actionMoveWindow(b, manager().get_workspace_by_index(2));
            await sleep(600);
            await this._moveTo(800, 500);
            await this._drop();
        });

        await this._test('control: closing and reopening a window, with Drag to Workspace off', async () => {
            this._find('A').delete(global.get_current_time());
            await sleep(400);
            this._spawn('A');
            await this._waitWindow('A');
            // The dash redraws on a timer of about 20 seconds while the overview is closed.
            await sleep(30000);
        });

        await this._test('control: ordinary window activity for a while, with Drag to Workspace off', async () => {
            const a = this._find('A');
            for (let i = 0; i < 12; i++) {
                await this._reset();
                await this._grabTitlebar(a);
                await this._moveTo(W - 300, 400);
                await this._drop();
                a.change_workspace_by_index(1, true);
                await sleep(1500);
            }
        });
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
        const toss = Main.extensionManager.lookup('drag-to-workspace@aahil-khan.github.com');
        check(toss?.stateObj?._overlay, `Drag to Workspace did not load: state=${toss?.state} error=${toss?.error}`);

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
                    win = global.display.list_all_windows().find(w => /Drag to Workspace/.test(w.get_title() ?? ''));
                }
                check(win, 'no settings window appeared');
                await sleep(800);
                win.activate(global.get_current_time());
                await sleep(400);
                await this._shot('20-prefs-area');
                // Fonts move everything around on other distros, so these positions only
                // hold on the development machine.
                if (GLib.getenv('DTW_PREFS_BASIC'))
                    return;
                const settings = toss.stateObj.getSettings();
                const r = rectOf(win);
                const at = (x, y) => [r.x + x, r.y + y];
                const gripX = 140;
                const zone = side => [settings.get_int(`${side}-zone-start`), settings.get_int(`${side}-zone-end`)].join('-');
                const dragFrom = async (x, y, dy) => {
                    await this._moveTo(...at(x, y));
                    await sleep(80);
                    this._button(true);
                    await sleep(60);
                    await this._moveTo(...at(x, y + dy), {steps: 10});
                    await sleep(60);
                    this._button(false);
                    await sleep(250);
                };

                // Layout measured from the screenshot: track from y=172 to y=434, default end at 67%.
                await dragFrom(gripX, 349, -90);
                const [, afterEnd] = zone('left').split('-').map(Number);
                check(afterEnd > 25 && afterEnd < 45, `end grip left the zone at ${zone('left')}`);
                check(zone('left') === zone('right'), `linked edges differ: ${zone('left')} and ${zone('right')}`);

                // Slide the whole area down by dragging its middle.
                const middle = 172 + 262 * afterEnd / 200;
                await dragFrom(gripX, middle, 100);
                const [slidStart, slidEnd] = zone('left').split('-').map(Number);
                check(slidStart > 25 && slidEnd - slidStart === afterEnd, `slide left the zone at ${zone('left')}`);

                // Unlinked, the edges move separately. The right grip is at the mirror position.
                settings.set_boolean('link-edges', false);
                await sleep(200);
                const before = zone('left');
                const rightGripX = 538;
                const startY = 172 + 262 * slidStart / 100;
                await dragFrom(rightGripX, startY, -60);
                check(zone('left') === before, `left moved with right: ${zone('left')}`);
                check(zone('right') !== before, 'right grip did nothing');
                await this._shot('21-prefs-area-unlinked');

                // Linking again copies the left edge across.
                settings.set_boolean('link-edges', true);
                await sleep(300);
                check(zone('left') === zone('right'), `relinking left ${zone('left')} and ${zone('right')}`);

                // A turned off edge can't be grabbed, and says so.
                settings.set_boolean('right-enabled', false);
                await sleep(200);
                const offBefore = zone('right');
                await dragFrom(rightGripX, startY, 40);
                check(zone('right') === offBefore, 'dragged a turned off edge');
                await this._shot('22-prefs-area-right-off');

                await this._moveTo(...at(273, 22));
                await sleep(80);
                this._button(true);
                await sleep(40);
                this._button(false);
                await sleep(500);
                await this._shot('23-prefs-behaviour');

                await this._moveTo(...at(405, 22));
                await sleep(80);
                this._button(true);
                await sleep(40);
                this._button(false);
                await sleep(500);
                await this._shot('24-prefs-timing');

                // Play the timing preview, and catch it part way.
                await this._moveTo(...at(564, 328));
                await sleep(80);
                this._button(true);
                await sleep(40);
                this._button(false);
                await sleep(800);
                await this._shot('25-prefs-timing-playing');

                // Reset puts everything back, including what was changed above.
                settings.set_int('hold-delay-ms', 900);
                await sleep(150);
                // The reset row is below the fold, so scroll down to it.
                await this._moveTo(...at(340, 500));
                for (let i = 0; i < 12; i++) {
                    this._pointer.notify_discrete_scroll(now(), Clutter.ScrollDirection.DOWN, Clutter.ScrollSource.WHEEL);
                    await sleep(40);
                }
                await sleep(600);
                await this._shot('25b-prefs-reset-row');
                await this._moveTo(...at(340, 744));
                await sleep(80);
                this._button(true);
                await sleep(40);
                this._button(false);
                await sleep(400);
                check(settings.get_int('hold-delay-ms') === 350, `hold is ${settings.get_int('hold-delay-ms')}`);
                check(zone('left') === '0-67', `left zone is ${zone('left')}`);
                check(settings.get_boolean('right-enabled'), 'right edge stayed off');

                // The hold-only edges are further down the Zones page.
                await this._moveTo(...at(60, 22));
                await this._moveTo(...at(153, 22));
                await sleep(80);
                this._button(true);
                await sleep(40);
                this._button(false);
                await sleep(400);
                await this._moveTo(...at(340, 500));
                for (let i = 0; i < 12; i++) {
                    this._pointer.notify_discrete_scroll(now(), Clutter.ScrollDirection.DOWN, Clutter.ScrollSource.WHEEL);
                    await sleep(40);
                }
                await sleep(600);
                await this._shot('26-prefs-hold-only-edges');

                // The excluded apps page, with one in the list, then its dialog.
                settings.set_strv('excluded-apps', ['dev.dragtoworkspace.Client.E.desktop']);
                await this._moveTo(...at(537, 22));
                await sleep(80);
                this._button(true);
                await sleep(40);
                this._button(false);
                await sleep(500);
                await this._shot('27-prefs-apps');
                await this._moveTo(...at(594, 103));
                await sleep(80);
                this._button(true);
                await sleep(40);
                this._button(false);
                await sleep(700);
                await this._shot('28-prefs-apps-dialog');
                settings.reset('excluded-apps');
            });

            this._finish(null);
            return;
        }

        if (SCENARIO === 'control') {
            await this._controlRun(toss);
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
