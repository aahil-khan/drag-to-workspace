import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import PangoCairo from 'gi://PangoCairo';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {moveZone, zonePartAt} from './lib/logic.js';

const SCREEN_ASPECT = 16 / 10;
const STRIP_WIDTH = 30;
const STRIP_INSET = 10;
const PANEL_HEIGHT = 12;
const HANDLE_HEIGHT = 8;
const HANDLE_TOLERANCE = 14;

function readZone(settings, side) {
    return {
        start: settings.get_int(`${side}-zone-start`),
        end: settings.get_int(`${side}-zone-end`),
    };
}

/** Writes a zone, to both sides while they're linked. */
function writeZone(settings, side, zone) {
    const sides = settings.get_boolean('link-edges') ? ['left', 'right'] : [side];
    for (const s of sides) {
        settings.set_int(`${s}-zone-end`, zone.end);
        settings.set_int(`${s}-zone-start`, zone.start);
    }
}

/**
 * A little screen with the two edges on it. Drag a handle to resize the area that
 * throws, or drag the area itself to slide it along the edge.
 */
const ZoneEditor = GObject.registerClass(
class EdgeTossZoneEditor extends Gtk.DrawingArea {
    _init(settings) {
        super._init({
            content_height: 280,
            hexpand: true,
            margin_top: 14,
            margin_bottom: 14,
            accessible_role: Gtk.AccessibleRole.IMG,
        });
        this._settings = settings;
        this._active = null;
        this.set_draw_func((_area, cr, width, height) => {
            this._draw(cr, width, height);
            cr.$dispose();
        });

        const redraw = () => this.queue_draw();
        for (const key of ['left-enabled', 'right-enabled', 'left-zone-start', 'left-zone-end',
            'right-zone-start', 'right-zone-end'])
            settings.connect(`changed::${key}`, redraw);
        Adw.StyleManager.get_default().connect('notify::accent-color', redraw);
        Adw.StyleManager.get_default().connect('notify::dark', redraw);

        const drag = new Gtk.GestureDrag();
        drag.connect('drag-begin', (_g, x, y) => this._onDragBegin(x, y));
        drag.connect('drag-update', (_g, dx, dy) => this._onDragUpdate(dy));
        drag.connect('drag-end', () => {
            this._active = null;
            this.queue_draw();
        });
        this.add_controller(drag);

        const motion = new Gtk.EventControllerMotion();
        motion.connect('motion', (_c, x, y) => this._onMotion(x, y));
        this.add_controller(motion);
    }

    _screen(width, height) {
        const h = Math.min(height, (width - 8) / SCREEN_ASPECT);
        const w = h * SCREEN_ASPECT;
        const x = (width - w) / 2;
        const y = (height - h) / 2;
        return {x, y, w, h, top: y + PANEL_HEIGHT + 4, trackHeight: h - PANEL_HEIGHT - 12};
    }

    _stripX(side, screen) {
        return side === 'left'
            ? screen.x + STRIP_INSET
            : screen.x + screen.w - STRIP_INSET - STRIP_WIDTH;
    }

    _hit(x, y) {
        const screen = this._screen(this.get_width(), this.get_height());
        const side = ['left', 'right'].find(s => {
            const stripX = this._stripX(s, screen);
            return x >= stripX - 12 && x <= stripX + STRIP_WIDTH + 12;
        });
        if (!side || !this._settings.get_boolean(`${side}-enabled`))
            return null;

        const percent = (y - screen.top) / screen.trackHeight * 100;
        const tolerance = HANDLE_TOLERANCE / screen.trackHeight * 100;
        const part = zonePartAt(percent, readZone(this._settings, side), tolerance);
        return part ? {side, part} : null;
    }

    _onMotion(x, y) {
        if (this._active)
            return;
        const hit = this._hit(x, y);
        if (!hit)
            this.set_cursor_from_name(null);
        else
            this.set_cursor_from_name(hit.part === 'body' ? 'grab' : 'ns-resize');
    }

    _onDragBegin(x, y) {
        const hit = this._hit(x, y);
        this._active = hit ? {...hit, zone: readZone(this._settings, hit.side)} : null;
        this.queue_draw();
    }

    _onDragUpdate(dy) {
        if (!this._active)
            return;
        const {side, part, zone} = this._active;
        const screen = this._screen(this.get_width(), this.get_height());
        const delta = dy / screen.trackHeight * 100;
        const from = part === 'end' ? zone.end : zone.start;
        writeZone(this._settings, side, moveZone(zone, part, from + delta));
    }

    _text(cr, text, x, y, align, color) {
        const layout = this.create_pango_layout(text);
        const [, logical] = layout.get_pixel_extents();
        cr.setSourceRGBA(color.red, color.green, color.blue, color.alpha);
        const left = align === 'right' ? x - logical.width : x;
        cr.moveTo(left, y - logical.height / 2);
        PangoCairo.show_layout(cr, layout);
    }

    _roundRect(cr, x, y, w, h, r) {
        cr.newSubPath();
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
    }

    _draw(cr, width, height) {
        const fg = this.get_color();
        const accent = Adw.StyleManager.get_default().get_accent_color_rgba();
        const neutral = alpha => cr.setSourceRGBA(fg.red, fg.green, fg.blue, alpha);
        const screen = this._screen(width, height);

        this._roundRect(cr, screen.x, screen.y, screen.w, screen.h, 10);
        neutral(0.07);
        cr.fillPreserve();
        neutral(0.25);
        cr.setLineWidth(1);
        cr.stroke();

        // Top bar, and a window for scale.
        neutral(0.12);
        this._roundRect(cr, screen.x + 1, screen.y + 1, screen.w - 2, PANEL_HEIGHT, 6);
        cr.fill();
        const winW = screen.w * 0.34;
        const winH = screen.h * 0.36;
        const winX = screen.x + (screen.w - winW) / 2;
        const winY = screen.y + screen.h * 0.5 - winH / 2;
        this._roundRect(cr, winX, winY, winW, winH, 6);
        neutral(0.1);
        cr.fillPreserve();
        neutral(0.3);
        cr.stroke();
        neutral(0.18);
        cr.rectangle(winX + 1, winY + 12, winW - 2, 1);
        cr.fill();

        for (const side of ['left', 'right'])
            this._drawEdge(cr, side, screen, fg, accent);
    }

    _drawEdge(cr, side, screen, fg, accent) {
        const enabled = this._settings.get_boolean(`${side}-enabled`);
        const zone = readZone(this._settings, side);
        const x = this._stripX(side, screen);
        const {top, trackHeight} = screen;
        const y1 = top + trackHeight * zone.start / 100;
        const y2 = top + trackHeight * zone.end / 100;

        const labelAlign = side === 'left' ? 'left' : 'right';
        const labelX = side === 'left' ? x + STRIP_WIDTH + 10 : x - 10;
        const dim = {red: fg.red, green: fg.green, blue: fg.blue, alpha: 0.6};

        // The whole edge, which GNOME keeps wherever Edge Toss doesn't.
        this._roundRect(cr, x, top, STRIP_WIDTH, trackHeight, 7);
        cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.14);
        cr.fill();

        if (!enabled) {
            this._text(cr, 'Off', labelX, top + trackHeight / 2, labelAlign, dim);
            return;
        }

        const lift = this._active?.side === side ? 1 : 0.85;
        cr.setSourceRGBA(accent.red, accent.green, accent.blue, lift);
        this._roundRect(cr, x, y1, STRIP_WIDTH, y2 - y1, 7);
        cr.fill();

        // Grips, one at each end of the area.
        for (const y of [y1, y2]) {
            const gripY = Math.max(Math.min(y, top + trackHeight - HANDLE_HEIGHT / 2), top + HANDLE_HEIGHT / 2);
            this._roundRect(cr, x - 4, gripY - HANDLE_HEIGHT / 2, STRIP_WIDTH + 8, HANDLE_HEIGHT, 4);
            cr.setSourceRGBA(1, 1, 1, 1);
            cr.fillPreserve();
            cr.setSourceRGBA(0, 0, 0, 0.35);
            cr.setLineWidth(1);
            cr.stroke();
        }

        if (y2 - y1 > 34)
            this._text(cr, 'Throws', labelX, (y1 + y2) / 2, labelAlign, fg);
        if (y1 - top > 34)
            this._text(cr, 'Half-tiles', labelX, (top + y1) / 2, labelAlign, dim);
        if (top + trackHeight - y2 > 34)
            this._text(cr, 'Half-tiles', labelX, (y2 + top + trackHeight) / 2, labelAlign, dim);
    }
});

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function comboRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(c => c.label)),
    });
    const sync = () => {
        row.selected = Math.max(choices.findIndex(c => c.value === settings.get_string(key)), 0);
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const value = choices[row.selected].value;
        if (settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** A percent row for one end of a zone, kept valid against the other end. */
function zoneSpinRow(settings, side, part, title) {
    const key = `${side}-zone-${part}`;
    const row = new Adw.SpinRow({
        title,
        adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 1, page_increment: 10}),
    });
    const sync = () => {
        row.value = settings.get_int(key);
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::value', () => {
        if (row.value === settings.get_int(key))
            return;
        writeZone(settings, side, moveZone(readZone(settings, side), part, row.value));
        // moveZone may have refused part of the change.
        sync();
    });
    return row;
}

function edgeRow(settings, side, title) {
    const row = new Adw.ExpanderRow({title, show_enable_switch: true, expanded: true});
    settings.bind(`${side}-enabled`, row, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
    row.add_row(zoneSpinRow(settings, side, 'start', 'Area starts at (% from the top)'));
    row.add_row(zoneSpinRow(settings, side, 'end', 'Area ends at (% from the top)'));
    return row;
}

/** Runs the two holds at their real speed, since milliseconds are hard to imagine. */
function timingPreviewRow(settings) {
    const row = new Adw.ActionRow({
        title: 'Try the timing',
        subtitle: 'Plays both holds at their real speed',
    });

    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, valign: Gtk.Align.CENTER, width_request: 150});
    const holdBar = new Gtk.ProgressBar();
    const followBar = new Gtk.ProgressBar();
    box.append(holdBar);
    box.append(followBar);
    row.add_suffix(box);

    const button = new Gtk.Button({label: 'Play', valign: Gtk.Align.CENTER});
    row.add_suffix(button);

    let tickId = 0;
    const stop = () => {
        if (tickId)
            box.remove_tick_callback(tickId);
        tickId = 0;
    };
    box.connect('unrealize', stop);

    button.connect('clicked', () => {
        stop();
        const hold = settings.get_int('hold-delay-ms');
        const follow = settings.get_int('follow-delay-ms');
        const started = GLib.get_monotonic_time();
        tickId = box.add_tick_callback(() => {
            const elapsed = (GLib.get_monotonic_time() - started) / 1000;
            holdBar.fraction = Math.min(elapsed / hold, 1);
            followBar.fraction = Math.min(Math.max(elapsed - hold, 0) / follow, 1);
            if (elapsed < hold + follow + 500)
                return GLib.SOURCE_CONTINUE;
            holdBar.fraction = 0;
            followBar.fraction = 0;
            tickId = 0;
            return GLib.SOURCE_REMOVE;
        });
    });
    return row;
}

export default class EdgeTossPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 800);
        window.add(this._areaPage(settings));
        window.add(this._behaviourPage(settings));
        window.add(this._timingPage(settings, window));
    }

    _areaPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Area', icon_name: 'view-fullscreen-symbolic'});

        const editor = new Adw.PreferencesGroup({
            title: 'Where it throws',
            description: 'Drag the white grips to resize the area, or drag the area to slide it. The rest of the edge keeps GNOME’s half-tiling.',
        });
        const frame = new Gtk.Box({css_classes: ['card']});
        frame.append(new ZoneEditor(settings));
        editor.add(frame);
        page.add(editor);

        const edges = new Adw.PreferencesGroup({title: 'Edges'});
        const link = switchRow(settings, 'link-edges', 'Same area on both edges', null);
        edges.add(link);
        edges.add(edgeRow(settings, 'left', 'Left edge'));
        const right = edgeRow(settings, 'right', 'Right edge');
        edges.add(right);
        page.add(edges);

        // Linking takes the left edge's area, so the two can't start out different.
        settings.connect('changed::link-edges', () => {
            if (settings.get_boolean('link-edges'))
                writeZone(settings, 'left', readZone(settings, 'left'));
        });

        const reach = new Adw.PreferencesGroup({title: 'Reach'});
        reach.add(spinRow(settings, 'edge-depth', 'Distance from the edge',
            'How close the pointer has to be, in pixels. GNOME half-tiles within 48, so anything less leaves a strip that half-tiles before you reach the edge.',
            1, 150, 1));
        reach.add(comboRow(settings, 'monitors', 'Monitors',
            'Edges shared between two monitors never throw', [
                {value: 'all', label: 'All monitors'},
                {value: 'primary', label: 'Primary only'},
            ]));
        page.add(reach);
        return page;
    }

    _behaviourPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Behaviour', icon_name: 'preferences-system-symbolic'});

        const drop = new Adw.PreferencesGroup({title: 'Dropping'});
        drop.add(comboRow(settings, 'drop-action', 'A normal drop',
            'The two options below swap this', [
                {value: 'stay', label: 'Stay here'},
                {value: 'follow', label: 'Go with it'},
            ]));
        page.add(drop);

        const swap = new Adw.PreferencesGroup({title: 'Swapping it'});
        swap.add(switchRow(settings, 'hold-to-follow', 'Hold on a workspace',
            'The card in the picker fills up, and the drop swaps when it’s full'));
        swap.add(comboRow(settings, 'follow-modifier', 'Hold a key',
            'Shift isn’t offered because GNOME uses it for snapping during a drag. Releasing Alt can open the menu bar in some apps.', [
                {value: 'ctrl', label: 'Ctrl'},
                {value: 'alt', label: 'Alt'},
                {value: 'none', label: 'None'},
            ]));
        page.add(swap);

        const targets = new Adw.PreferencesGroup({title: 'Workspaces'});
        targets.add(switchRow(settings, 'offer-new-workspace', 'Offer a new workspace',
            'Adds a + card with dynamic workspaces. Without it, the empty last workspace isn’t a target.'));
        page.add(targets);
        return page;
    }

    _timingPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Timing & Look', icon_name: 'preferences-system-time-symbolic'});

        const timing = new Adw.PreferencesGroup({title: 'Timing'});
        timing.add(spinRow(settings, 'hold-delay-ms', 'Open the picker after',
            'Milliseconds at the edge. Dropping sooner sends to the next workspace.', 100, 1500, 50));
        const follow = spinRow(settings, 'follow-delay-ms', 'Fill the card in',
            'Milliseconds holding on one workspace in the picker', 200, 3000, 50);
        settings.bind('hold-to-follow', follow, 'sensitive', Gio.SettingsBindFlags.GET);
        timing.add(follow);
        timing.add(timingPreviewRow(settings));
        page.add(timing);

        const look = new Adw.PreferencesGroup({title: 'Look'});
        look.add(spinRow(settings, 'card-width', 'Picker card width',
            'Largest width, in pixels. Cards shrink to fit when there are many workspaces.', 120, 360, 8));
        look.add(switchRow(settings, 'show-hint', 'Show the area while approaching',
            'A thin bar along the edge'));
        look.add(switchRow(settings, 'show-confirmation', 'Show where the window went',
            'A brief label at the edge after a throw'));
        look.add(switchRow(settings, 'animate-throw', 'Animate the throw',
            'The window flies off the edge. Also off when GNOME’s animations are off.'));
        page.add(look);

        const reset = new Adw.PreferencesGroup();
        const resetRow = new Adw.ButtonRow({title: 'Reset all to defaults'});
        resetRow.connect('activated', () => {
            for (const key of settings.settings_schema.list_keys())
                settings.reset(key);
            window.add_toast(new Adw.Toast({title: 'Settings reset'}));
        });
        reset.add(resetRow);
        page.add(reset);
        return page;
    }
}
