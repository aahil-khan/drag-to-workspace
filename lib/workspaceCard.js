// One workspace in the picker: a live thumbnail, plus what's needed to choose it.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';

const MAX_ICONS = 4;
const ICON_SIZE = 18;
const ICONS_MIN_CARD_HEIGHT = 60;
const TOP_ROW_MARGIN = 6;

export const WorkspaceCard = GObject.registerClass(
class EdgeTossWorkspaceCard extends St.Widget {
    constructor({label, isNew, workspace, monitor, width, height, draggedWindow, showAppIcons, outerPart}) {
        super({
            style_class: 'edge-toss-card',
            width,
            height,
        });

        // The clip lives on an inner holder so it doesn't cut off the card's shadow.
        const holder = new St.Widget({width, height, clip_to_allocation: true});
        this.add_child(holder);

        const scale = width / monitor.width;
        this._contents = new Clutter.Actor({
            width: monitor.width,
            height: monitor.height,
            scale_x: scale,
            scale_y: scale,
        });
        holder.add_child(this._contents);

        const backgroundGroup = new Meta.BackgroundGroup();
        this._contents.add_child(backgroundGroup);
        this._background = new Background.BackgroundManager({
            container: backgroundGroup,
            monitorIndex: monitor.index,
            vignette: false,
        });

        const windows = workspace ? this._windowsOn(workspace, monitor, draggedWindow) : [];
        this._addThumbnails(windows, monitor);

        // Sweeps across the whole card while holding on it, on top of the thumbnail.
        this._fill = new St.Widget({style_class: 'edge-toss-fill', width, height, scale_x: 0});
        holder.add_child(this._fill);

        // With the split gesture, the part nearest the screen edge, where a drop does the opposite.
        this._outerPart = outerPart ? this._makeOuterPart(outerPart, width, height) : null;
        if (this._outerPart)
            holder.add_child(this._outerPart);

        // A row along the top, so a long name gives way to the icons instead of overlapping.
        const topRow = new St.BoxLayout({
            x: TOP_ROW_MARGIN,
            y: TOP_ROW_MARGIN,
            width: width - TOP_ROW_MARGIN * 2,
            style_class: 'edge-toss-card-top',
        });
        this.add_child(topRow);

        this._badge = new St.Label({
            style_class: isNew ? 'edge-toss-badge edge-toss-badge-new' : 'edge-toss-badge',
            text: label,
            y_align: Clutter.ActorAlign.START,
        });
        this._badge.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        topRow.add_child(this._badge);
        topRow.add_child(new St.Widget({x_expand: true}));

        if (showAppIcons && height >= ICONS_MIN_CARD_HEIGHT)
            this._addAppIcons(windows, topRow);

        this._caption = new St.Label({style_class: 'edge-toss-caption', opacity: 0});
        this.add_child(this._caption);

        // Children draw over a widget's own border, so the outline is its own actor.
        this._frame = new St.Widget({style_class: 'edge-toss-card-frame', width, height});
        this.add_child(this._frame);

        this._cardWidth = width;
        this._cardHeight = height;
        this._flipped = false;
        this.pivot_point = new Graphene.Point({x: 0.5, y: 0.5});
        this.connect('destroy', () => this._background.destroy());
    }

    _makeOuterPart({side, fraction}, width, height) {
        const part = new St.Widget({style_class: 'edge-toss-outer-part', opacity: 0});
        if (side === 'top') {
            part.set_size(width, Math.round(height * fraction));
        } else {
            const partWidth = Math.round(width * fraction);
            part.set_size(partWidth, height);
            if (side === 'right')
                part.x = width - partWidth;
        }
        return part;
    }

    _windowsOn(workspace, monitor, draggedWindow) {
        return global.get_window_actors().filter(actor => {
            const win = actor.meta_window;
            return win !== draggedWindow &&
                !win.minimized &&
                !win.is_skip_taskbar() &&
                win.get_monitor() === monitor.index &&
                win.located_on_workspace(workspace);
        });
    }

    _addThumbnails(actors, monitor) {
        for (const actor of actors) {
            this._contents.add_child(new Clutter.Clone({
                source: actor,
                x: actor.x - monitor.x,
                y: actor.y - monitor.y,
                width: actor.width,
                height: actor.height,
            }));
        }
    }

    _addAppIcons(actors, topRow) {
        const tracker = Shell.WindowTracker.get_default();
        const apps = new Set(actors.map(actor => tracker.get_window_app(actor.meta_window)));
        apps.delete(null);
        if (apps.size === 0)
            return;

        this._icons = new St.BoxLayout({
            style_class: 'edge-toss-card-icons',
            y_align: Clutter.ActorAlign.START,
        });
        for (const app of [...apps].slice(0, MAX_ICONS))
            this._icons.add_child(app.create_icon_texture(ICON_SIZE));
        topRow.add_child(this._icons);
    }

    setState({selected, caption, progress, flipped}) {
        for (const actor of [this._frame, this._caption, this._fill]) {
            if (selected && flipped)
                actor.add_style_pseudo_class('checked');
            else
                actor.remove_style_pseudo_class('checked');
        }
        if (selected)
            this._frame.add_style_pseudo_class('selected');
        else
            this._frame.remove_style_pseudo_class('selected');

        this._caption.opacity = selected ? 255 : 0;
        if (selected && this._caption.text !== caption)
            this._caption.text = caption;
        if (selected) {
            const [, natural] = this._caption.get_preferred_width(-1);
            const [, naturalHeight] = this._caption.get_preferred_height(-1);
            this._caption.set_position(
                Math.round((this._cardWidth - natural) / 2),
                this._cardHeight - naturalHeight - 8);
        }

        if (this._outerPart) {
            // Shown faintly on the selected card so it can be found, and strongly when in use.
            this._outerPart.opacity = selected ? 255 : 0;
            if (selected && flipped)
                this._outerPart.add_style_pseudo_class('checked');
            else
                this._outerPart.remove_style_pseudo_class('checked');
        } else {
            this._fill.scale_x = !selected ? 0 : flipped ? 1 : progress;
        }

        // A small pop when the fill completes, so that the change can't be missed.
        const isFlipped = selected && flipped;
        if (isFlipped && !this._flipped)
            this._pop();
        this._flipped = isFlipped;
    }

    _pop() {
        this.remove_all_transitions();
        this.ease({
            scale_x: 1.06,
            scale_y: 1.06,
            duration: 90,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this.ease({
                scale_x: 1,
                scale_y: 1,
                duration: 140,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            }),
        });
    }
});
