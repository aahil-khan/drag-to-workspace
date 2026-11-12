// Pure drag logic: no GNOME imports, so it runs under `node --test`.
// All timing comes in through `now`, and the session owns no timers.

export const Phase = Object.freeze({IDLE: 'idle', ARMED: 'armed', PICKER: 'picker'});

const HINT_DISTANCE = 220;
const SELECT_JITTER = 10;
const PICKER_EXIT_MARGIN = 48;

/** The gap between a side picker's cards and the screen edge. */
export const PICKER_EDGE_GAP = 6;
const NARROW_CARD = 150;
const TOP_BAND = 2;
const SOFT_HOLD_MIN = 600;
const SOFT_TAB_AFTER = 0.3;
const SLOT_RATIO = 0.5;
const SLOT_MIN = 68;

/** The value of DragSession.selected while the pointer is on the new-workspace slot. */
export const SLOT = -2;

export const MIN_ZONE_SPAN = 5;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

const contains = (m, x, y) =>
    x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height;

function monitorAt(x, y, monitors) {
    return monitors.findIndex(m => contains(m, x, y));
}

/** True if nothing lies beyond this side of the monitor at height y. */
function isOuterEdge(side, monitor, y, monitors) {
    const beyond = side === 'left' ? monitor.x - 1 : monitor.x + monitor.width;
    return monitorAt(beyond, y, monitors) < 0;
}

function verticalFraction(y, workArea) {
    return clamp((y - workArea.y) / Math.max(workArea.height, 1), 0, 1);
}

/**
 * Which edge the pointer is on, if any. The side strips mirror where Mutter tiles, in
 * update_move_maybe_tile() of meta-window-drag.c. `kind` is:
 *   outer   a side edge with nothing beyond it
 *   shared  a side edge next to another monitor, which the pointer has to be able to cross
 *   top     the top edge, where GNOME maximizes
 * Shared and top edges have to be asked for.
 */
export function findEdge(x, y, monitors, band, {sharedEdges = false, topEdge = false} = {}) {
    const index = monitorAt(x, y, monitors);
    if (index < 0)
        return null;

    const monitor = monitors[index];
    const wa = monitor.workArea;
    let side = null;
    if (x < wa.x + band)
        side = 'left';
    else if (x >= wa.x + wa.width - band)
        side = 'right';

    if (side) {
        const outer = isOuterEdge(side, monitor, y, monitors);
        if (outer || sharedEdges) {
            const kind = outer ? 'outer' : 'shared';
            return {side, kind, monitorIndex: index, fraction: verticalFraction(y, wa)};
        }
    }

    if (topEdge && y <= wa.y + TOP_BAND && monitorAt(x, monitor.y - 1, monitors) < 0)
        return {side: 'top', kind: 'top', monitorIndex: index, fraction: 0};

    return null;
}

/** A zone is a part of an edge's height, as fractions from 0 at the top to 1 at the bottom. */
export function isTossHeight(fraction, zone) {
    return fraction >= zone.start && (fraction < zone.end || zone.end >= 1);
}

/** The vertical span of a monitor's edge that belongs to Drag to Workspace. */
export function tossSpan(workArea, zone) {
    return {
        y: workArea.y + Math.round(workArea.height * zone.start),
        height: Math.round(workArea.height * (zone.end - zone.start)),
    };
}

/**
 * Where a drag in the settings' area editor leaves a zone. Works in whole percents.
 * `handle` is 'start', 'end', or 'body' to slide the whole zone, where `percent` is
 * the new start.
 */
export function moveZone(zone, handle, percent) {
    const p = Math.round(percent);
    if (handle === 'start')
        return {start: clamp(p, 0, zone.end - MIN_ZONE_SPAN), end: zone.end};
    if (handle === 'end')
        return {start: zone.start, end: clamp(p, zone.start + MIN_ZONE_SPAN, 100)};

    const span = zone.end - zone.start;
    const start = clamp(p, 0, 100 - span);
    return {start, end: start + span};
}

/** What the area editor would grab at a height, in percent. Handles beat the body. */
export function zonePartAt(percent, zone, tolerance) {
    const toStart = Math.abs(percent - zone.start);
    const toEnd = Math.abs(percent - zone.end);
    if (Math.min(toStart, toEnd) <= tolerance)
        return toStart <= toEnd ? 'start' : 'end';
    return percent > zone.start && percent < zone.end ? 'body' : null;
}

/** Which words belong on the selected card: 'send', 'go', 'hold-go', 'hold-stay' or 'hold'. */
export function captionFor({dropAction, followProgress, flipped, cardWidth}) {
    const toFollow = dropAction !== 'follow';
    if (flipped)
        return toFollow ? 'go' : 'send';
    if (followProgress <= 0)
        return toFollow ? 'send' : 'go';
    if (cardWidth < NARROW_CARD)
        return 'hold';
    return toFollow ? 'hold-go' : 'hold-stay';
}

/**
 * Workspaces reachable from one side, nearest first, or for 'top' every workspace in order.
 * index -1 means "insert a new workspace before the first one".
 */
export function computeTargets({activeIndex, count, side, dynamic, lastIsEmpty, windowAlone, offerNew = true}) {
    const targets = [];
    if (side === 'top') {
        for (let i = 0; i < count; i++) {
            if (i !== activeIndex)
                targets.push({index: i, isNew: dynamic && lastIsEmpty && i === count - 1});
        }
    } else if (side === 'right') {
        for (let i = activeIndex + 1; i < count; i++)
            targets.push({index: i, isNew: dynamic && lastIsEmpty && i === count - 1});
    } else {
        for (let i = activeIndex - 1; i >= 0; i--)
            targets.push({index: i, isNew: false});
        if (dynamic)
            targets.push({index: -1, isNew: true, insertAt: 0});
    }
    // Moving the only window on a workspace to a brand new one changes nothing.
    return windowAlone || !offerNew ? targets.filter(t => !t.isNew) : targets;
}

/**
 * A new workspace squeezed in right next to the current one, on a side picker: between it
 * and the next workspace on that side. Inserting needs dynamic workspaces, and isn't offered
 * where the nearest target is already a new workspace, since that would be the same move.
 */
export function computeSlot({activeIndex, side, dynamic, windowAlone, offerNew = true, targets}) {
    if (side === 'top' || !dynamic || windowAlone || !offerNew)
        return null;
    if (targets.length === 0 || targets[0].isNew)
        return null;
    return {index: -1, isNew: true, insertAt: side === 'right' ? activeIndex + 1 : activeIndex, slot: true};
}

/**
 * Sizes and places the column of cards against the edge of the work area. With `slot`, a
 * slim new-workspace slot sits before the first card, and `slotRect` says where.
 */
export function layoutPicker({count, pointerY, workArea, aspect, maxCardWidth = 208, gap = 8, margin = 12, slot = false}) {
    const gaps = gap * (count - 1 + (slot ? 1 : 0));
    const available = workArea.height - margin * 2 - gaps;
    const maxCardHeight = Math.round(maxCardWidth / aspect);
    const shares = count + (slot ? SLOT_RATIO : 0);
    let cardHeight = Math.min(maxCardHeight, Math.floor(available / shares));
    const slotHeight = slot ? Math.max(Math.round(cardHeight * SLOT_RATIO), SLOT_MIN) : 0;
    // The slot's minimum height comes out of the cards.
    cardHeight = Math.max(Math.min(cardHeight, Math.floor((available - slotHeight) / count)), 24);
    const cardWidth = Math.min(Math.round(cardHeight * aspect), maxCardWidth);
    const before = slot ? slotHeight + gap : 0;
    const total = before + cardHeight * count + gap * (count - 1);

    // The pointer lands on the first card, not on the slot.
    const lowest = workArea.y + margin;
    const highest = Math.max(workArea.y + workArea.height - margin - total, lowest);
    const top = clamp(Math.round(pointerY - cardHeight / 2 - before), lowest, highest);

    const rects = [];
    for (let i = 0; i < count; i++)
        rects.push({y: top + before + i * (cardHeight + gap), height: cardHeight});
    const slotRect = slot ? {y: top, height: slotHeight} : null;

    return {top, cardWidth, cardHeight, gap, total, rects, slotRect};
}

/** Sizes and places a row of cards along the top of the work area, centred. */
export function layoutStrip({count, workArea, aspect, maxCardWidth = 208, gap = 8, margin = 12}) {
    const available = workArea.width - margin * 2 - gap * (count - 1);
    const cardWidth = Math.max(Math.min(maxCardWidth, Math.floor(available / count)), 48);
    const cardHeight = Math.round(cardWidth / aspect);
    const total = cardWidth * count + gap * (count - 1);
    const left = workArea.x + Math.round((workArea.width - total) / 2);
    const top = workArea.y + margin;

    const rects = [];
    for (let i = 0; i < count; i++)
        rects.push({x: left + i * (cardWidth + gap), y: top, width: cardWidth, height: cardHeight});

    return {top, cardWidth, cardHeight, gap, total, rects};
}

/** The card nearest the pointer, along the axis the cards run on. */
export function cardAt(position, rects, axis = 'y') {
    const size = axis === 'y' ? 'height' : 'width';
    let best = 0;
    let bestDistance = Infinity;
    rects.forEach((r, i) => {
        const distance = Math.abs(position - (r[axis] + r[size] / 2));
        if (distance < bestDistance) {
            best = i;
            bestDistance = distance;
        }
    });
    return best;
}

const DEFAULT_ZONES = Object.freeze({
    left: Object.freeze({enabled: true, start: 0, end: 0.67}),
    right: Object.freeze({enabled: true, start: 0, end: 0.67}),
});

/**
 * One window drag, from grab to drop.
 *
 *   idle --reach toss part of edge--> armed --hold--> picker
 *   armed/picker --move away--> idle
 *
 * Shared and top edges are "soft". The pointer passes through them all the time, and GNOME
 * uses them for crossing monitors and maximizing, so they take a longer hold, and a drop only
 * moves the window once the pointer has picked a card. Anything else stays GNOME's.
 *
 * `getTargets(side)` supplies the workspaces and is re-read after invalidate().
 */
export class DragSession {
    constructor({getTargets, getSlot = () => null, band, aspect, zones = DEFAULT_ZONES, allowMonitor = () => true,
        holdDelay = 350, followDelay = 1200, followStartDelay = 500, pickerGesture = 'split', splitSide = 'inner', splitPercent = 50,
        dropAction = 'stay', cardWidth = 208,
        sharedEdges = false, topEdge = false}) {
        this._getTargets = getTargets;
        this._getSlot = getSlot;
        this._band = band;
        this._aspect = aspect;
        this._zones = zones;
        this._allowMonitor = allowMonitor;
        this._pickerGesture = pickerGesture;
        this._splitSide = splitSide;
        this._splitFraction = splitPercent / 100;
        this._cardWidth = cardWidth;
        this._edgeOptions = {sharedEdges, topEdge};
        this._holdDelay = holdDelay;
        this._followDelay = followDelay;
        this._followStartDelay = followStartDelay;
        this._dropAction = dropAction;

        this.phase = Phase.IDLE;
        this.side = null;
        this.kind = null;
        this.monitorIndex = -1;
        this.pointerMonitor = -1;
        this.keyTarget = null;
        this.targets = [];
        this.slot = null;
        this.targetsVersion = 0;
        this.layout = null;
        this.selected = 0;
        this.holdProgress = 0;
        this.followProgress = 0;
        this.inOppositePart = false;
        this.hint = null;
        this.pointerX = 0;
        this.pointerY = 0;

        // A grab that starts with the pointer already on the edge, such as a
        // click on a window flush against it, must not throw the window.
        this._leftEdge = false;
        this._stale = false;
        this._armedAt = 0;
        this._selectedAt = 0;
        this._openedAt = 0;
        this._moved = false;
    }

    /** Workspaces changed mid-drag. Re-read targets on the next update. */
    invalidate() {
        this._stale = true;
    }

    /**
     * A number key was pressed, choosing a workspace wherever the pointer is. Pressing the
     * same number again changes your mind.
     */
    chooseNumber(number) {
        const target = this._getTargets('top').find(t => t.index === number - 1);
        if (!target)
            return;
        this.keyTarget = this.keyTarget?.index === target.index ? null : target;
        this._toIdle();
        this.hint = null;
    }

    update(x, y, now, monitors) {
        this.pointerX = x;
        this.pointerY = y;
        this.pointerMonitor = monitorAt(x, y, monitors);
        const edge = findEdge(x, y, monitors, this._band, this._edgeOptions);
        if (!edge)
            this._leftEdge = true;

        if (this._stale)
            this._refreshTargets(now, monitors);
        if (this.keyTarget)
            return;

        switch (this.phase) {
        case Phase.IDLE:
            this._updateIdle(edge, x, y, now, monitors);
            break;
        case Phase.ARMED:
            this._updateArmed(edge, now, monitors);
            break;
        case Phase.PICKER:
            this._updatePicker(x, y, now, monitors);
            break;
        }
    }

    _updateIdle(edge, x, y, now, monitors) {
        this.hint = this._computeHint(x, y, monitors);
        if (!edge || !this._leftEdge || !this._edgeUsable(edge))
            return;

        const targets = this._getTargets(edge.side);
        if (targets.length === 0)
            return;

        this.side = edge.side;
        this.kind = edge.kind;
        this.monitorIndex = edge.monitorIndex;
        this._setTargets(targets);
        this.phase = Phase.ARMED;
        this.hint = null;
        this._armedAt = now;
        this.holdProgress = 0;
    }

    _updateArmed(edge, now, monitors) {
        const onSameEdge = edge && edge.side === this.side && edge.kind === this.kind &&
            edge.monitorIndex === this.monitorIndex &&
            this._edgeUsable(edge);
        if (!onSameEdge) {
            this._toIdle();
            return;
        }

        const delay = this.isSoft ? Math.max(this._holdDelay * 2, SOFT_HOLD_MIN) : this._holdDelay;
        this.holdProgress = clamp((now - this._armedAt) / delay, 0, 1);
        if (this.holdProgress >= 1)
            this._openPicker(now, monitors);
    }

    _openPicker(now, monitors) {
        this.phase = Phase.PICKER;
        this._openedAt = this._alongCards();
        this._moved = false;
        this.selected = this._firstSelection();
        this._selectedAt = now;
        this.followProgress = 0;
        this._relayout(monitors);
        this.inOppositePart = this._hasSelection &&
            this._pointerInOppositePart(this.pointerX, this.pointerY, monitors[this.monitorIndex]);
    }

    _alongCards() {
        return this.side === 'top' ? this.pointerX : this.pointerY;
    }

    /** Which card a picker opens with: the nearest, or on a soft edge none at all. */
    _firstSelection() {
        return this.isSoft ? -1 : 0;
    }

    _distanceFromPickerEdge(x, y, monitor) {
        if (this.side === 'top')
            return y - this.layout.top - this.layout.cardHeight;
        const distance = this.side === 'left' ? x - monitor.x : monitor.x + monitor.width - 1 - x;
        return distance - this.layout.cardWidth;
    }

    _updatePicker(x, y, now, monitors) {
        const monitor = monitors[this.monitorIndex];
        if (!contains(monitor, x, y) ||
            this._distanceFromPickerEdge(x, y, monitor) > PICKER_EXIT_MARGIN) {
            this._toIdle();
            return;
        }

        // The picker can open with a far card under the pointer, so nothing changes
        // until the pointer actually moves.
        const along = this._alongCards();
        if (Math.abs(along - this._openedAt) > SELECT_JITTER)
            this._moved = true;
        const wanted = this._moved ? this._selectionAt(along) : this._firstSelection();
        if (wanted !== this.selected) {
            this.selected = wanted;
            this._selectedAt = now;
        }
        this.followProgress = this._hasSelection ? this._followProgressAt(now) : 0;
        this.inOppositePart = this._hasSelection && this._pointerInOppositePart(x, y, monitor);
    }

    /** The card under a position along the column, or SLOT for the new-workspace slot. */
    _selectionAt(along) {
        const {slotRect, rects, gap} = this.layout;
        if (slotRect && along < slotRect.y + slotRect.height + gap / 2)
            return SLOT;
        return cardAt(along, rects, this.side === 'top' ? 'x' : 'y');
    }

    /**
     * With the split gesture, whether the pointer is on the part of the selected card where
     * a drop does the opposite of the usual. That part is the inner one, away from the screen
     * edge, or the outer one, next to it.
     */
    _pointerInOppositePart(x, y, monitor) {
        if (this._pickerGesture !== 'split')
            return false;
        const outerFraction = this.splitLayout.outerFraction;
        let inOuter;
        if (this.side === 'top') {
            inOuter = y < this.layout.top + this.layout.cardHeight * outerFraction;
        } else {
            const fromEdge = this.side === 'left' ? x - monitor.x : monitor.x + monitor.width - 1 - x;
            inOuter = fromEdge < PICKER_EDGE_GAP + this.layout.cardWidth * outerFraction;
        }
        return inOuter === (this._splitSide === 'outer');
    }

    get pickerGesture() {
        return this._pickerGesture;
    }

    /** How the cards are split: the outer part's share, and whether it's the opposite one. */
    get splitLayout() {
        const oppositeIsOuter = this._splitSide === 'outer';
        return {
            outerFraction: oppositeIsOuter ? this._splitFraction : 1 - this._splitFraction,
            oppositeIsOuter,
        };
    }

    /**
     * Fills from nothing to full, ending at followDelay. It waits followStartDelay before
     * starting, so that sweeping across cards doesn't make each one flicker.
     */
    _followProgressAt(now) {
        if (this._pickerGesture !== 'hold')
            return 0;
        const wait = Math.min(this._followStartDelay, this._followDelay / 2);
        return clamp((now - this._selectedAt - wait) / (this._followDelay - wait), 0, 1);
    }

    _edgeUsable(edge) {
        if (edge.kind === 'top')
            return this._allowMonitor(edge.monitorIndex);

        const zone = this._zones[edge.side];
        return zone.enabled &&
            this._allowMonitor(edge.monitorIndex) &&
            isTossHeight(edge.fraction, zone);
    }

    zoneFor(side) {
        return this._zones[side];
    }

    get isSoft() {
        return this.kind === 'shared' || this.kind === 'top';
    }

    /** Whether to show the tab. On a soft edge it waits, so that passing through stays quiet. */
    get showsTab() {
        return this.phase === Phase.ARMED && (!this.isSoft || this.holdProgress > SOFT_TAB_AFTER);
    }

    /** Whether a drop right now would move the window, so GNOME's previews should stay away. */
    get ownsPointer() {
        if (this.keyTarget)
            return true;
        if (this.phase === Phase.PICKER)
            return this._hasSelection;
        return this.phase === Phase.ARMED && !this.isSoft;
    }

    _toIdle() {
        this.phase = Phase.IDLE;
        this.side = null;
        this.kind = null;
        this.monitorIndex = -1;
        this.layout = null;
        this.holdProgress = 0;
        this.followProgress = 0;
        this.inOppositePart = false;
    }

    _setTargets(targets) {
        this.targets = targets;
        this.slot = this.side === 'top' ? null : this._getSlot(this.side, targets);
        this.targetsVersion++;
    }

    get _hasSelection() {
        return this.selected >= 0 || this.selected === SLOT;
    }

    _relayout(monitors) {
        const params = {
            count: this.targets.length,
            workArea: monitors[this.monitorIndex].workArea,
            aspect: this._aspect,
            maxCardWidth: this._cardWidth,
        };
        this.layout = this.side === 'top'
            ? layoutStrip(params)
            : layoutPicker({...params, pointerY: this.pointerY, slot: Boolean(this.slot)});
    }

    _refreshTargets(now, monitors) {
        this._stale = false;
        if (this.keyTarget && !this._getTargets('top').some(t => t.index === this.keyTarget.index))
            this.keyTarget = null;
        if (this.phase === Phase.IDLE)
            return;

        const targets = this._getTargets(this.side);
        if (targets.length === 0) {
            this._toIdle();
            return;
        }

        this._setTargets(targets);
        if (this.phase === Phase.PICKER) {
            this.selected = this._firstSelection();
            this._moved = false;
            this._openedAt = this._alongCards();
            this._selectedAt = now;
            this._relayout(monitors);
        }
    }

    _computeHint(x, y, monitors) {
        const index = monitorAt(x, y, monitors);
        if (index < 0 || !this._leftEdge)
            return null;

        const monitor = monitors[index];
        const wa = monitor.workArea;
        const toLeft = x - wa.x;
        const toRight = wa.x + wa.width - x;
        const side = toLeft <= toRight ? 'left' : 'right';
        const distance = Math.min(toLeft, toRight);
        if (distance > HINT_DISTANCE || !isOuterEdge(side, monitor, y, monitors))
            return null;
        if (!this._zones[side].enabled || !this._allowMonitor(index))
            return null;
        if (this._getTargets(side).length === 0)
            return null;

        return {
            side,
            monitorIndex: index,
            strength: 1 - clamp((distance - this._band) / (HINT_DISTANCE - this._band), 0, 1),
        };
    }

    /** Whether the usual drop action has been swapped, by the modifier or by holding on a card. */
    isFlipped(modifierHeld = false) {
        if (modifierHeld)
            return true;
        if (this.phase !== Phase.PICKER)
            return false;
        return this.inOppositePart || this.followProgress >= 1;
    }

    /** Whether letting go now would go with the window. */
    willFollow(modifierHeld = false) {
        const flipped = this.isFlipped(modifierHeld);
        return this._dropAction === 'follow' ? !flipped : flipped;
    }

    /**
     * What a drop would do right now, or null for an ordinary move. `goNow` is a
     * right-click, which goes with the window whatever the usual action is.
     */
    decide(modifierHeld = false, goNow = false) {
        if (!this.ownsPointer)
            return null;
        let target = this.keyTarget;
        if (!target && this.phase === Phase.PICKER)
            target = this.selected === SLOT ? this.slot : this.targets[this.selected];
        else if (!target)
            target = this.targets[0];
        return {target, follow: goNow || this.willFollow(modifierHeld)};
    }

    get dropAction() {
        return this._dropAction;
    }
}
