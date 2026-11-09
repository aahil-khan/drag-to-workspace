// What you see during a drag: the edge hint, the tab and the picker.
// Nothing here is reactive. The window drag owns the pointer, so all hit testing
// happens in DragSession from pointer coordinates.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {captionFor, Phase, tossSpan} from './logic.js';

const FADE_MS = 120;
const FLY_MS = 220;
const TAB_MARGIN = 6;
const HINT_WIDTH = 6;

const arrow = side => (side === 'left' ? '←' : '→');
const targetLabel = target => (target.isNew ? '+' : `${target.index + 1}`);

const WorkspaceCard = GObject.registerClass(
class EdgeTossWorkspaceCard extends St.Widget {
    constructor({target, workspace, monitor, width, height, draggedWindow}) {
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

        if (workspace)
            this._addWindows(workspace, monitor, draggedWindow);

        // Sweeps across the whole card while holding on it, on top of the thumbnail.
        this._fill = new St.Widget({style_class: 'edge-toss-fill', width, height, scale_x: 0});
        holder.add_child(this._fill);

        const badge = new St.Label({
            style_class: target.isNew ? 'edge-toss-badge edge-toss-badge-new' : 'edge-toss-badge',
            text: targetLabel(target),
        });
        badge.set_position(6, 6);
        this.add_child(badge);

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

    _addWindows(workspace, monitor, draggedWindow) {
        const actors = global.get_window_actors().filter(actor => {
            const win = actor.meta_window;
            return win !== draggedWindow &&
                !win.minimized &&
                !win.is_skip_taskbar() &&
                win.get_monitor() === monitor.index &&
                win.located_on_workspace(workspace);
        });

        for (const actor of actors) {
            const clone = new Clutter.Clone({
                source: actor,
                x: actor.x - monitor.x,
                y: actor.y - monitor.y,
                width: actor.width,
                height: actor.height,
            });
            this._contents.add_child(clone);
        }
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

        this._fill.scale_x = !selected ? 0 : flipped ? 1 : progress;

        // A small pop when the load completes, so that the change can't be missed.
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

export class Overlay {
    constructor() {
        this._root = new St.Widget({name: 'edgeTossOverlay', reactive: false});
        Main.layoutManager.uiGroup.add_child(this._root);

        this._hint = new St.Widget({style_class: 'edge-toss-hint', opacity: 0, visible: false});
        this._root.add_child(this._hint);

        this._tab = new St.BoxLayout({style_class: 'edge-toss-tab', opacity: 0, visible: false});
        this._tabLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._tab.add_child(this._tabLabel);
        this._tabProgress = new St.Widget({style_class: 'edge-toss-progress', height: 3, scale_x: 0});
        this._root.add_child(this._tab);
        this._root.add_child(this._tabProgress);

        this._picker = null;
        this._pickerVersion = -1;
    }

    destroy() {
        this._destroyPicker();
        this._root.destroy();
    }

    /** Draws the current state of a session. Called on every tick of a drag. */
    render(session, context) {
        this._renderHint(session, context);

        if (session.phase === Phase.ARMED)
            this._renderTab(session, context);
        else
            this._hideTab();

        if (session.phase === Phase.PICKER)
            this._renderPicker(session, context);
        else
            this._destroyPicker();
    }

    clear() {
        this._hint.visible = false;
        this._hideTab();
        this._destroyPicker();
    }

    _renderHint(session, {monitors, options}) {
        const hint = session.hint;
        if (!hint || !options.showHint) {
            this._hint.visible = false;
            return;
        }

        const monitor = monitors[hint.monitorIndex];
        const span = tossSpan(monitor.workArea, session.zoneFor(hint.side));
        this._hint.set_position(
            hint.side === 'left' ? monitor.x : monitor.x + monitor.width - HINT_WIDTH,
            span.y);
        this._hint.set_size(HINT_WIDTH, span.height);
        this._hint.opacity = Math.round(60 + 195 * hint.strength);
        this._hint.visible = true;
    }

    _renderTab(session, {monitors, modifierHeld}) {
        const monitor = monitors[session.monitorIndex];
        const target = session.targets[0];
        const going = session.willFollow(modifierHeld) ? 'Go with it' : '';
        const text = session.side === 'left'
            ? `${arrow('left')}  ${targetLabel(target)}  ${going}`.trimEnd()
            : `${going}  ${targetLabel(target)}  ${arrow('right')}`.trimStart();
        if (this._tabLabel.text !== text)
            this._tabLabel.text = text;

        if (!this._tab.visible) {
            this._tab.visible = true;
            this._tabProgress.visible = true;
            this._tab.remove_all_transitions();
            this._tab.ease({opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }

        const [, width] = this._tab.get_preferred_width(-1);
        const [, height] = this._tab.get_preferred_height(-1);
        const x = session.side === 'left'
            ? monitor.x + TAB_MARGIN
            : monitor.x + monitor.width - width - TAB_MARGIN;
        const wa = monitor.workArea;
        const y = Math.min(Math.max(session.pointerY - height / 2, wa.y + TAB_MARGIN),
            wa.y + wa.height - height - TAB_MARGIN);
        this._tab.set_position(x, Math.round(y));
        this._tabProgress.set_position(x + 10, Math.round(y) + height - 6);
        this._tabProgress.width = width - 20;
        this._tabProgress.scale_x = session.holdProgress;
    }

    _hideTab() {
        this._tab.remove_all_transitions();
        this._tab.opacity = 0;
        this._tab.visible = false;
        this._tabProgress.visible = false;
    }

    _renderPicker(session, context) {
        if (session.targetsVersion !== this._pickerVersion)
            this._buildPicker(session, context);

        const flipped = session.isFlipped(context.modifierHeld);
        const caption = captionFor({
            dropAction: session.dropAction,
            followProgress: session.followProgress,
            flipped,
            cardWidth: session.layout.cardWidth,
        });
        this._cards.forEach((card, i) => {
            card.setState({
                selected: i === session.selected,
                caption,
                progress: session.followProgress,
                flipped,
            });
            if (i === session.selected)
                this._picker.set_child_above_sibling(card, null);
        });
    }

    _buildPicker(session, {monitors, originMonitor, targetWorkspace, draggedWindow}) {
        this._destroyPicker();

        const monitor = monitors[session.monitorIndex];
        const {cardWidth, cardHeight, rects} = session.layout;
        const x = session.side === 'left'
            ? monitor.x + TAB_MARGIN
            : monitor.x + monitor.width - cardWidth - TAB_MARGIN;

        this._picker = new St.Widget({opacity: 0});
        this._cards = session.targets.map((target, i) => {
            const card = new WorkspaceCard({
                target,
                workspace: targetWorkspace(target),
                monitor: originMonitor,
                width: cardWidth,
                height: cardHeight,
                draggedWindow,
            });
            card.set_position(x, rects[i].y);
            this._picker.add_child(card);
            return card;
        });
        this._root.add_child(this._picker);
        this._pickerVersion = session.targetsVersion;

        const slide = session.side === 'left' ? -16 : 16;
        this._picker.translation_x = slide;
        this._picker.ease({
            opacity: 255,
            translation_x: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _destroyPicker() {
        this._picker?.destroy();
        this._picker = null;
        this._cards = [];
        this._pickerVersion = -1;
    }

    /** A snapshot of the window sliding off the edge, so a throw reads as a throw. */
    flyOut(content, rect, side, monitor) {
        if (!St.Settings.get().enable_animations)
            return;

        const snapshot = new St.Widget({
            content,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this._root.add_child(snapshot);

        const edgeX = side === 'left'
            ? monitor.x - rect.width * 0.4
            : monitor.x + monitor.width - rect.width * 0.6;
        snapshot.ease({
            x: edgeX,
            scale_x: 0.8,
            scale_y: 0.8,
            opacity: 0,
            duration: FLY_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => snapshot.destroy(),
        });
    }

    /** A brief "it went to 3" at the edge after a throw. */
    confirm(side, target, monitor, y) {
        const label = new St.Label({
            style_class: 'edge-toss-tab',
            text: side === 'left'
                ? `${arrow('left')}  ${targetLabel(target)}`
                : `${targetLabel(target)}  ${arrow('right')}`,
        });
        this._root.add_child(label);
        const [, width] = label.get_preferred_width(-1);
        const [, height] = label.get_preferred_height(-1);
        const wa = monitor.workArea;
        label.set_position(
            side === 'left' ? monitor.x + TAB_MARGIN : monitor.x + monitor.width - width - TAB_MARGIN,
            Math.round(Math.min(Math.max(y - height / 2, wa.y + TAB_MARGIN), wa.y + wa.height - height - TAB_MARGIN)));
        label.ease({
            opacity: 0,
            delay: 450,
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => label.destroy(),
        });
    }
}
