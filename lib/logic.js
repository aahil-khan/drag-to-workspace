// Pure drag logic: no GNOME imports, so it runs under `node --test`.
// All timing comes in through `now`, and the session owns no timers.

export const Phase = Object.freeze({IDLE: 'idle', ARMED: 'armed', PICKER: 'picker'});

const HINT_DISTANCE = 220;
const SELECT_JITTER = 10;
const PICKER_EXIT_MARGIN = 48;
const FOLLOW_GRACE = 250;
const NARROW_CARD = 150;

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
 * The strip where the pointer would make Mutter tile, limited to outer edges.
 * Between monitors the pointer has to be able to cross, so those edges keep
 * GNOME's own behaviour. Mirrors update_move_maybe_tile() in meta-window-drag.c.
 */
export function findEdge(x, y, monitors, band) {
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

    if (!side || !isOuterEdge(side, monitor, y, monitors))
        return null;

    return {side, monitorIndex: index, fraction: verticalFraction(y, wa)};
}

/** A zone is a part of an edge's height, as fractions from 0 at the top to 1 at the bottom. */
export function isTossHeight(fraction, zone) {
    return fraction >= zone.start && (fraction < zone.end || zone.end >= 1);
}

/** The vertical span of a monitor's edge that belongs to Edge Toss. */
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

/** The words on the selected card. */
export function captionFor({dropAction, followProgress, flipped, cardWidth}) {
    const toFollow = dropAction !== 'follow';
    const usual = toFollow ? 'Send here' : 'Go with it';
    const other = toFollow ? 'Go with it' : 'Send here';
    if (flipped)
        return other;
    if (followProgress <= 0)
        return usual;
    if (cardWidth < NARROW_CARD)
        return 'Hold\u2026';
    return toFollow ? 'Hold to go with it' : 'Hold to stay here';
}

/**
 * Workspaces reachable from one side, nearest first.
 * index -1 means "insert a new workspace before the first one".
 */
export function computeTargets({activeIndex, count, side, dynamic, lastIsEmpty, windowAlone, offerNew = true}) {
    const targets = [];
    if (side === 'right') {
        for (let i = activeIndex + 1; i < count; i++)
            targets.push({index: i, isNew: dynamic && lastIsEmpty && i === count - 1});
    } else {
        for (let i = activeIndex - 1; i >= 0; i--)
            targets.push({index: i, isNew: false});
        if (dynamic)
            targets.push({index: -1, isNew: true});
    }
    // Moving the only window on a workspace to a brand new one changes nothing.
    return windowAlone || !offerNew ? targets.filter(t => !t.isNew) : targets;
}

/** Sizes and places the column of cards against the edge of the work area. */
export function layoutPicker({count, pointerY, workArea, aspect, maxCardWidth = 208, gap = 8, margin = 12}) {
    const available = workArea.height - margin * 2 - gap * (count - 1);
    const maxCardHeight = Math.round(maxCardWidth / aspect);
    const cardHeight = Math.max(Math.min(maxCardHeight, Math.floor(available / count)), 24);
    const cardWidth = Math.min(Math.round(cardHeight * aspect), maxCardWidth);
    const total = cardHeight * count + gap * (count - 1);

    const lowest = workArea.y + margin;
    const highest = Math.max(workArea.y + workArea.height - margin - total, lowest);
    const top = clamp(Math.round(pointerY - cardHeight / 2), lowest, highest);

    const rects = [];
    for (let i = 0; i < count; i++)
        rects.push({y: top + i * (cardHeight + gap), height: cardHeight});

    return {top, cardWidth, cardHeight, gap, total, rects};
}

/** The card nearest the pointer. Only height matters: the pointer sits on the edge. */
export function cardAt(y, rects) {
    let best = 0;
    let bestDistance = Infinity;
    rects.forEach((r, i) => {
        const distance = Math.abs(y - (r.y + r.height / 2));
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
 * `getTargets(side)` supplies the workspaces and is re-read after invalidate().
 */
export class DragSession {
    constructor({getTargets, band, aspect, zones = DEFAULT_ZONES, allowMonitor = () => true,
        holdDelay = 350, followDelay = 1200, holdToFollow = true, dropAction = 'stay', cardWidth = 208}) {
        this._getTargets = getTargets;
        this._band = band;
        this._aspect = aspect;
        this._zones = zones;
        this._allowMonitor = allowMonitor;
        this._holdToFollow = holdToFollow;
        this._cardWidth = cardWidth;
        this._holdDelay = holdDelay;
        this._followDelay = followDelay;
        this._dropAction = dropAction;

        this.phase = Phase.IDLE;
        this.side = null;
        this.monitorIndex = -1;
        this.targets = [];
        this.targetsVersion = 0;
        this.layout = null;
        this.selected = 0;
        this.holdProgress = 0;
        this.followProgress = 0;
        this.hint = null;
        this.pointerY = 0;

        // A grab that starts with the pointer already on the edge, such as a
        // click on a window flush against it, must not throw the window.
        this._leftEdge = false;
        this._stale = false;
        this._armedAt = 0;
        this._selectedAt = 0;
        this._openedY = 0;
        this._moved = false;
    }

    /** Workspaces changed mid-drag. Re-read targets on the next update. */
    invalidate() {
        this._stale = true;
    }

    update(x, y, now, monitors) {
        this.pointerY = y;
        const edge = findEdge(x, y, monitors, this._band);
        if (!edge)
            this._leftEdge = true;

        if (this._stale)
            this._refreshTargets(now, monitors);

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
        this.monitorIndex = edge.monitorIndex;
        this._setTargets(targets);
        this.phase = Phase.ARMED;
        this.hint = null;
        this._armedAt = now;
        this.holdProgress = 0;
    }

    _updateArmed(edge, now, monitors) {
        const onSameEdge = edge && edge.side === this.side &&
            edge.monitorIndex === this.monitorIndex &&
            this._edgeUsable(edge);
        if (!onSameEdge) {
            this._toIdle();
            return;
        }

        this.holdProgress = clamp((now - this._armedAt) / this._holdDelay, 0, 1);
        if (this.holdProgress >= 1)
            this._openPicker(now, monitors);
    }

    _openPicker(now, monitors) {
        this.phase = Phase.PICKER;
        this._openedY = this.pointerY;
        this._moved = false;
        this.selected = 0;
        this._selectedAt = now;
        this.followProgress = 0;
        this._relayout(monitors);
    }

    _updatePicker(x, y, now, monitors) {
        const monitor = monitors[this.monitorIndex];
        const distance = this.side === 'left'
            ? x - monitor.x
            : monitor.x + monitor.width - 1 - x;
        const onMonitor = contains(monitor, x, y);
        if (!onMonitor || distance > this.layout.cardWidth + PICKER_EXIT_MARGIN) {
            this._toIdle();
            return;
        }

        // The picker can open with a far card under the pointer. Keep the nearest
        // workspace selected until the pointer actually moves.
        if (Math.abs(y - this._openedY) > SELECT_JITTER)
            this._moved = true;
        const wanted = this._moved ? cardAt(y, this.layout.rects) : 0;
        if (wanted !== this.selected) {
            this.selected = wanted;
            this._selectedAt = now;
        }
        this.followProgress = this._followProgressAt(now);
    }

    /**
     * Fills from nothing to full, ending at followDelay. It holds back for a moment so
     * that sweeping across cards doesn't make each one flicker.
     */
    _followProgressAt(now) {
        if (!this._holdToFollow)
            return 0;
        const grace = Math.min(FOLLOW_GRACE, this._followDelay / 4);
        return clamp((now - this._selectedAt - grace) / (this._followDelay - grace), 0, 1);
    }

    _edgeUsable(edge) {
        const zone = this._zones[edge.side];
        return zone.enabled &&
            this._allowMonitor(edge.monitorIndex) &&
            isTossHeight(edge.fraction, zone);
    }

    zoneFor(side) {
        return this._zones[side];
    }

    _toIdle() {
        this.phase = Phase.IDLE;
        this.side = null;
        this.monitorIndex = -1;
        this.layout = null;
        this.holdProgress = 0;
        this.followProgress = 0;
    }

    _setTargets(targets) {
        this.targets = targets;
        this.targetsVersion++;
    }

    _relayout(monitors) {
        this.layout = layoutPicker({
            count: this.targets.length,
            pointerY: this.pointerY,
            workArea: monitors[this.monitorIndex].workArea,
            aspect: this._aspect,
            maxCardWidth: this._cardWidth,
        });
    }

    _refreshTargets(now, monitors) {
        this._stale = false;
        if (this.phase === Phase.IDLE)
            return;

        const targets = this._getTargets(this.side);
        if (targets.length === 0) {
            this._toIdle();
            return;
        }

        this._setTargets(targets);
        if (this.phase === Phase.PICKER) {
            this.selected = 0;
            this._moved = false;
            this._openedY = this.pointerY;
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
        return modifierHeld || (this.phase === Phase.PICKER && this.followProgress >= 1);
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
        if (this.phase === Phase.IDLE || this.targets.length === 0)
            return null;
        const target = this.phase === Phase.PICKER
            ? this.targets[this.selected]
            : this.targets[0];
        return {target, follow: goNow || this.willFollow(modifierHeld)};
    }

    get dropAction() {
        return this._dropAction;
    }
}
