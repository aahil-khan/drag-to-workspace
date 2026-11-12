// What you see during a drag: the edge hint, the tab and the picker. Apart from the popup
// after a move, nothing here is reactive. The window drag owns the pointer, so all hit
// testing happens in DragSession from pointer coordinates.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {captionFor, Phase, PICKER_EDGE_GAP, SLOT, tossSpan} from './logic.js';
import {MovedPopup} from './movedPopup.js';
import {WorkspaceCard} from './workspaceCard.js';

const FADE_MS = 120;
const FLY_MS = 220;
const TAB_MARGIN = 6;
const HINT_WIDTH = 6;
const KEY_TAB_OFFSET = 24;
const POPUP_ABOVE_POINTER = 16;
const SLIDE_MS = 160;
// The picker's cards come out one after another, from the one under the pointer outwards.
// Only for looks: choosing a card goes by the pointer, so a quick drop never waits for it.
const WAVE_STEP_MS = 22;
const WAVE_MAX_DELAY_MS = 110;
const CARD_IN_MS = 200;
const CARD_IN_OFFSET = 28;
const CARD_IN_SCALE = 0.92;
const PLUS_SIZE = 18;

function targetNumber(target, shift = 0) {
    return target.isNew ? '+' : `${target.index + 1 + shift}`;
}

function captionText(key) {
    switch (key) {
    case 'send':
        return _('Send here');
    case 'go':
        return _('Go with it');
    case 'hold-go':
        return _('Hold to go with it');
    case 'hold-stay':
        return _('Hold to stay here');
    default:
        return _('Hold…');
    }
}

function shortText(action) {
    return action === 'go' ? _('Go') : _('Send');
}

function clampedY(y, height, workArea) {
    return Math.round(Math.min(Math.max(y - height / 2, workArea.y + TAB_MARGIN),
        workArea.y + workArea.height - height - TAB_MARGIN));
}

export class Overlay {
    constructor() {
        this._root = new St.Widget({name: 'dragToWorkspaceOverlay', reactive: false});
        Main.layoutManager.uiGroup.add_child(this._root);

        this._hint = new St.Widget({style_class: 'drag-to-workspace-hint', opacity: 0, visible: false});
        this._root.add_child(this._hint);

        this._tab = new St.BoxLayout({style_class: 'drag-to-workspace-tab', opacity: 0, visible: false});
        this._tabLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._tab.add_child(this._tabLabel);
        this._tabProgress = new St.Widget({style_class: 'drag-to-workspace-progress', height: 3, scale_x: 0});
        this._root.add_child(this._tab);
        this._root.add_child(this._tabProgress);

        this._picker = null;
        this._pickerVersion = -1;
        this._popup = null;
    }

    destroy() {
        this._destroyPicker();
        this._popup?.close();
        this._root.destroy();
    }

    /** Draws the current state of a session. Called on every tick of a drag. */
    render(session, context) {
        this._renderHint(session, context);

        if (session.keyTarget)
            this._renderKeyTab(session, context);
        else if (session.showsTab)
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

    _tabText(session, {modifierHeld, allWindowsHeld, arrows}) {
        if (session.isSoft)
            return _('Hold for workspaces');

        const going = session.willFollow(modifierHeld) ? _('Go with it') : '';
        const all = allWindowsHeld ? _('All windows') : '';
        const extras = [all, going].filter(text => text).join('  ');
        const number = targetNumber(session.targets[0]);
        return session.side === 'left'
            ? `${arrows.left}  ${number}  ${extras}`.trimEnd()
            : `${extras}  ${number}  ${arrows.right}`.trimStart();
    }

    _showTab(text) {
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
        return {width, height};
    }

    _placeTab(x, y, width, height, progress) {
        this._tab.set_position(x, y);
        this._tabProgress.set_position(x + 10, y + height - 6);
        this._tabProgress.width = width - 20;
        this._tabProgress.scale_x = progress;
    }

    _renderTab(session, context) {
        const monitor = context.monitors[session.monitorIndex];
        const wa = monitor.workArea;
        const {width, height} = this._showTab(this._tabText(session, context));

        let x, y;
        if (session.side === 'top') {
            x = Math.round(Math.min(Math.max(session.pointerX - width / 2, wa.x + TAB_MARGIN),
                wa.x + wa.width - width - TAB_MARGIN));
            y = wa.y + TAB_MARGIN;
        } else {
            x = session.side === 'left'
                ? monitor.x + TAB_MARGIN
                : monitor.x + monitor.width - width - TAB_MARGIN;
            y = clampedY(session.pointerY, height, wa);
        }
        this._placeTab(x, y, width, height, session.holdProgress);
    }

    /** With a number chosen, there's no edge to point at, so it follows the pointer. */
    _renderKeyTab(session, {monitors, originMonitor, modifierHeld, allWindowsHeld}) {
        const monitor = monitors[session.pointerMonitor] ?? originMonitor;
        const wa = monitor.workArea;
        const parts = [
            session.keyTarget.isNew
                ? _('Move to a new workspace')
                : _('Move to workspace %d').format(session.keyTarget.index + 1),
        ];
        if (allWindowsHeld)
            parts.push(_('All windows'));
        if (session.willFollow(modifierHeld))
            parts.push(_('Go with it'));

        const {width, height} = this._showTab(parts.join('  '));
        const x = Math.round(Math.min(session.pointerX + KEY_TAB_OFFSET, wa.x + wa.width - width - TAB_MARGIN));
        const y = clampedY(session.pointerY - KEY_TAB_OFFSET - height / 2, height, wa);
        this._placeTab(x, y, width, height, 0);
    }

    _hideTab() {
        this._tab.remove_all_transitions();
        this._tab.opacity = 0;
        this._tab.visible = false;
        this._tabProgress.visible = false;
    }

    /** Labels each part of a split card with what a drop there does. */
    _splitFor(session) {
        const {outerFraction, oppositeIsOuter} = session.splitLayout;
        const usual = session.dropAction === 'follow' ? 'go' : 'send';
        const opposite = usual === 'go' ? 'send' : 'go';
        const outerAction = oppositeIsOuter ? opposite : usual;
        const innerAction = oppositeIsOuter ? usual : opposite;
        this._outerAction = outerAction;
        return {
            side: session.side,
            outerFraction,
            outerLabel: [captionText(outerAction), shortText(outerAction)],
            innerLabel: [captionText(innerAction), shortText(innerAction)],
        };
    }

    _renderPicker(session, context) {
        if (session.targetsVersion !== this._pickerVersion)
            this._buildPicker(session, context);

        const flipped = session.isFlipped(context.modifierHeld);
        const split = session.pickerGesture === 'split';
        let caption = '';
        if (!split) {
            caption = captionText(captionFor({
                dropAction: session.dropAction,
                followProgress: session.followProgress,
                flipped,
                cardWidth: session.layout.cardWidth,
            }));
        }
        // With the split gesture, each part already says what it does, so the parts say
        // "All windows" too, rather than a caption on top of them.
        if (context.allWindowsHeld && !split)
            caption = caption ? _('All windows: %s').format(caption) : _('All windows');

        // The part a drop would use, which a held key can swap whatever the pointer is on.
        const action = session.willFollow(context.modifierHeld) ? 'go' : 'send';
        const activePart = action === this._outerAction ? 'outer' : 'inner';

        const onSlot = session.selected === SLOT;
        if (this._placeholder && session.slotOpen && !this._slotOpen)
            this._openSlot(session);
        if (this._placeholder && onSlot !== this._onSlot)
            this._renumber(session, onSlot, context.options);

        const states = this._cards.map((card, i) => [card, i === session.selected]);
        if (this._placeholder)
            states.push([this._placeholder, onSlot]);
        for (const [card, selected] of states) {
            card.setState({
                selected,
                caption,
                progress: session.followProgress,
                flipped,
                activePart,
                allWindows: split && context.allWindowsHeld,
            });
            if (selected)
                this._picker.set_child_above_sibling(card, null);
        }
    }

    _cardLabel(target, workspaceNames, shift = 0) {
        const name = target.index >= 0 ? workspaceNames[target.index] : '';
        const number = targetNumber(target, shift);
        return name ? `${number}  ${name}` : number;
    }

    /** Opens the gap for a new workspace: the new card appears in it, and the others slide along. */
    _openSlot(session) {
        this._slotOpen = true;
        const duration = St.Settings.get().enable_animations ? SLIDE_MS : 0;
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        const {rects} = session.placement;
        this._cards.forEach((card, i) => card.ease({y: rects[i].y, duration, mode}));
        this._slotHandle.ease({opacity: 0, duration, mode});
        this._placeholder.visible = true;
        this._placeholder.ease({opacity: 255, scale_y: 1, duration, mode});
    }

    /**
     * While the new workspace is pointed at, it and the cards after it show the numbers
     * they'll have once it exists.
     */
    _renumber(session, onSlot, options) {
        this._onSlot = onSlot;
        const {insertAt} = session.slot;
        session.targets.forEach((target, i) => {
            const shift = onSlot && !target.isNew && target.index >= insertAt ? 1 : 0;
            this._cards[i].setLabel(this._cardLabel(target, options.workspaceNames, shift));
        });
        this._placeholder.setLabel(onSlot
            ? _('%d  New workspace').format(insertAt + 1)
            : _('New workspace'));
    }

    /** A thin line with a plus in the gap before the first card: room for a new workspace. */
    _makeSlotHandle(x, y, width, height) {
        const handle = new St.Widget({x, y, width, height, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        const lineWidth = Math.round(width * 0.7);
        handle.add_child(new St.Widget({
            style_class: 'drag-to-workspace-insert-line',
            x: Math.round((width - lineWidth) / 2),
            y: Math.round(height / 2) - 1,
            width: lineWidth,
            height: 2,
        }));
        handle.add_child(new St.Bin({
            style_class: 'drag-to-workspace-insert-plus',
            x: Math.round((width - PLUS_SIZE) / 2),
            y: Math.round((height - PLUS_SIZE) / 2),
            width: PLUS_SIZE,
            height: PLUS_SIZE,
            child: new St.Icon({icon_name: 'list-add-symbolic', icon_size: 12}),
        }));
        return handle;
    }

    _buildPicker(session, context) {
        this._destroyPicker();

        const {monitors, originMonitor, targetWorkspace, draggedWindow, options} = context;
        const monitor = monitors[session.monitorIndex];
        const {cardWidth, cardHeight, rects} = session.layout;
        const columnX = session.side === 'left'
            ? monitor.x + PICKER_EDGE_GAP
            : monitor.x + monitor.width - cardWidth - PICKER_EDGE_GAP;
        const split = session.pickerGesture === 'split' ? this._splitFor(session) : null;

        this._picker = new St.Widget({opacity: 0});
        this._cards = session.targets.map((target, i) => {
            const card = new WorkspaceCard({
                label: this._cardLabel(target, options.workspaceNames),
                isNew: target.isNew,
                workspace: targetWorkspace(target),
                monitor: originMonitor,
                width: cardWidth,
                height: cardHeight,
                draggedWindow,
                showAppIcons: options.showAppIcons,
                split,
            });
            card.set_position(rects[i].x ?? columnX, rects[i].y);
            this._picker.add_child(card);
            return card;
        });
        this._slotHandle = null;
        this._placeholder = null;
        this._slotOpen = false;
        this._onSlot = false;
        const {slotRect, open} = session.layout;
        if (session.slot && slotRect) {
            this._slotHandle = this._makeSlotHandle(columnX, slotRect.y, cardWidth, slotRect.height);
            this._picker.add_child(this._slotHandle);

            this._placeholder = new WorkspaceCard({
                label: _('New workspace'),
                isNew: true,
                workspace: null,
                monitor: originMonitor,
                width: cardWidth,
                height: open.slotRect.height,
                draggedWindow,
                showAppIcons: false,
                split,
            });
            this._placeholder.set_position(columnX, open.slotRect.y);
            this._placeholder.set_pivot_point(0.5, 0);
            this._placeholder.opacity = 0;
            this._placeholder.scale_y = 0.2;
            this._placeholder.visible = false;
            this._picker.add_child(this._placeholder);
        }
        this._root.add_child(this._picker);
        this._pickerVersion = session.targetsVersion;

        this._picker.opacity = 255;
        this._dealCards(session);
    }

    /** Deals the cards out from the edge in a quick wave, nearest the pointer first. */
    _dealCards(session) {
        if (!St.Settings.get().enable_animations)
            return;

        const {rects, slotRect} = session.layout;
        const horizontal = session.side === 'top';
        const pointer = horizontal ? session.pointerX : session.pointerY;
        const centre = r => horizontal ? r.x + r.width / 2 : r.y + r.height / 2;
        const actors = this._cards.map((card, i) => [card, Math.abs(centre(rects[i]) - pointer)]);
        if (this._slotHandle)
            actors.push([this._slotHandle, Math.abs(centre(slotRect) - pointer)]);
        actors.sort((a, b) => a[1] - b[1]);

        const offset = session.side === 'left' ? -CARD_IN_OFFSET : CARD_IN_OFFSET;
        actors.forEach(([actor], order) => {
            const delay = Math.min(order * WAVE_STEP_MS, WAVE_MAX_DELAY_MS);
            actor.opacity = 0;
            actor.scale_x = actor.scale_y = CARD_IN_SCALE;
            if (horizontal)
                actor.translation_y = -CARD_IN_OFFSET;
            else
                actor.translation_x = offset;
            actor.ease({
                translation_x: 0,
                translation_y: 0,
                scale_x: 1,
                scale_y: 1,
                delay,
                duration: CARD_IN_MS,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
            actor.ease({
                opacity: 255,
                delay,
                duration: CARD_IN_MS * 0.6,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
    }

    _destroyPicker() {
        this._picker?.destroy();
        this._picker = null;
        this._cards = [];
        this._slotHandle = null;
        this._placeholder = null;
        this._pickerVersion = -1;
    }

    /** A snapshot of the window sliding off the edge, so a move reads as a throw. */
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

    /** Says where the window went and offers Undo and Go. It sits above the pointer, not under it. */
    showMoved({side, target, monitor, x, y, count, buttons, duration, position, onUndo, onGo}) {
        this.closeMoved();

        const number = targetNumber(target);
        let text;
        if (target.isNew)
            text = count > 1 ? _('Moved to a new workspace (%d windows)').format(count) : _('Moved to a new workspace');
        else
            text = count > 1 ? _('Moved to %s (%d windows)').format(number, count) : _('Moved to %s').format(number);

        const popup = new MovedPopup({
            text,
            buttons,
            duration,
            onUndo,
            onGo,
            onClosed: () => {
                this._popup = null;
            },
        });
        this._popup = popup;

        const [, width] = popup.get_preferred_width(-1);
        const [, height] = popup.get_preferred_height(-1);
        const wa = monitor.workArea;
        let px, py;
        if (position === 'top') {
            px = wa.x + (wa.width - width) / 2;
            py = wa.y + TAB_MARGIN;
        } else if (position === 'pointer') {
            px = Math.min(Math.max(x - width / 2, wa.x + TAB_MARGIN), wa.x + wa.width - width - TAB_MARGIN);
            py = clampedY(y - POPUP_ABOVE_POINTER - height / 2, height, wa);
        } else {
            px = side === 'left' ? monitor.x + TAB_MARGIN : monitor.x + monitor.width - width - TAB_MARGIN;
            py = clampedY(y - POPUP_ABOVE_POINTER - height / 2, height, wa);
        }
        popup.set_position(Math.round(px), Math.round(py));
    }

    closeMoved() {
        this._popup?.close();
    }
}
