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

function targetNumber(target) {
    return target.isNew ? '+' : `${target.index + 1}`;
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

        const states = this._cards.map((card, i) => [card, i === session.selected]);
        if (this._slotCard)
            states.push([this._slotCard, session.selected === SLOT]);
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

    _cardLabel(target, workspaceNames) {
        const name = target.index >= 0 ? workspaceNames[target.index] : '';
        return name ? `${targetNumber(target)}  ${name}` : targetNumber(target);
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
        this._slotCard = null;
        const slotRect = session.layout.slotRect;
        if (session.slot && slotRect) {
            this._slotCard = new WorkspaceCard({
                label: _('+  New workspace here'),
                isNew: true,
                workspace: null,
                monitor: originMonitor,
                width: cardWidth,
                height: slotRect.height,
                draggedWindow,
                showAppIcons: false,
                split,
            });
            this._slotCard.set_position(columnX, slotRect.y);
            this._picker.add_child(this._slotCard);
        }
        this._root.add_child(this._picker);
        this._pickerVersion = session.targetsVersion;

        if (session.side === 'top')
            this._picker.translation_y = -16;
        else
            this._picker.translation_x = session.side === 'left' ? -16 : 16;
        this._picker.ease({
            opacity: 255,
            translation_x: 0,
            translation_y: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _destroyPicker() {
        this._picker?.destroy();
        this._picker = null;
        this._cards = [];
        this._slotCard = null;
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
