// The drawing of the screen on the Zones page, with a draggable zone on each edge.

import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import PangoCairo from 'gi://PangoCairo';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {moveZone, zonePartAt} from '../lib/logic.js';
import {accentColor} from './accent.js';

const SCREEN_ASPECT = 16 / 10;
const STRIP_WIDTH = 30;
const STRIP_INSET = 10;
const PANEL_HEIGHT = 12;
const HANDLE_HEIGHT = 8;
const HANDLE_TOLERANCE = 14;

export function readZone(settings, side) {
    return {
        start: settings.get_int(`${side}-zone-start`),
        end: settings.get_int(`${side}-zone-end`),
    };
}

/** Writes a zone, to both sides while they're linked. */
export function writeZone(settings, side, zone) {
    const sides = settings.get_boolean('link-edges') ? ['left', 'right'] : [side];
    for (const s of sides) {
        settings.set_int(`${s}-zone-end`, zone.end);
        settings.set_int(`${s}-zone-start`, zone.start);
    }
}

/**
 * A little screen with the two edges on it. Drag a handle to resize a zone, or drag the
 * zone itself to slide it along the edge.
 */
export const ZoneEditor = GObject.registerClass(
class DragToWorkspaceZoneEditor extends Gtk.DrawingArea {
    constructor(settings) {
        super({
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
        const accent = accentColor();
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

        // The whole edge, which GNOME keeps wherever Drag to Workspace doesn't.
        this._roundRect(cr, x, top, STRIP_WIDTH, trackHeight, 7);
        cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.14);
        cr.fill();

        if (!enabled) {
            this._text(cr, _('Off'), labelX, top + trackHeight / 2, labelAlign, dim);
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
            this._text(cr, _('Moves'), labelX, (y1 + y2) / 2, labelAlign, fg);
        if (y1 - top > 34)
            this._text(cr, _('Tiles'), labelX, (top + y1) / 2, labelAlign, dim);
        if (top + trackHeight - y2 > 34)
            this._text(cr, _('Tiles'), labelX, (y2 + top + trackHeight) / 2, labelAlign, dim);
    }
});
