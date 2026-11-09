import test from 'node:test';
import assert from 'node:assert/strict';

import {
    Phase, findEdge, isTossHeight, tossSpan, computeTargets, layoutPicker, cardAt, DragSession,
} from '../lib/logic.js';

const mon = (x, y, width, height, panel = 32) => ({
    x, y, width, height,
    workArea: {x, y: y + panel, width, height: height - panel},
});
const single = [mon(0, 0, 1600, 1000)];
const BAND = 48;

const session = (opts = {}) => new DragSession({
    getTargets: () => [{index: 1, isNew: false}, {index: 2, isNew: false}, {index: 3, isNew: true}],
    band: BAND,
    aspect: 1.6,
    ...opts,
});

/** Starts a drag away from the edge, then moves to (x, y) at time 0. */
const armedAt = (s, x = 1599, y = 300) => {
    s.update(800, 300, 0, single);
    s.update(x, y, 0, single);
    return s;
};

test('findEdge: left and right bands match where Mutter tiles', () => {
    assert.equal(findEdge(47, 300, single, BAND).side, 'left');
    assert.equal(findEdge(48, 300, single, BAND), null);
    assert.equal(findEdge(1551, 300, single, BAND), null);
    assert.equal(findEdge(1552, 300, single, BAND).side, 'right');
});

test('findEdge: an edge shared with another monitor does not count', () => {
    const two = [mon(0, 0, 1600, 1000), mon(1600, 0, 1600, 1000)];
    assert.equal(findEdge(1599, 300, two, BAND), null);
    assert.equal(findEdge(1600, 300, two, BAND), null);
    assert.equal(findEdge(0, 300, two, BAND).side, 'left');
    assert.equal(findEdge(3199, 300, two, BAND).side, 'right');
});

test('findEdge: staggered monitors only share part of the edge', () => {
    const two = [mon(0, 0, 1600, 1000), mon(1600, 500, 1600, 1000)];
    assert.equal(findEdge(1599, 300, two, BAND).side, 'right');
    assert.equal(findEdge(1599, 700, two, BAND), null);
    assert.equal(findEdge(1600, 700, two, BAND), null);
});

test('findEdge: a dock moves the band with the work area', () => {
    const docked = [{...mon(0, 0, 1600, 1000), workArea: {x: 70, y: 32, width: 1530, height: 968}}];
    assert.equal(findEdge(117, 300, docked, BAND).side, 'left');
    assert.equal(findEdge(118, 300, docked, BAND), null);
});

test('isTossHeight and tossSpan agree on the tiling zone', () => {
    assert.equal(isTossHeight(0.6, 'bottom', 33), true);
    assert.equal(isTossHeight(0.7, 'bottom', 33), false);
    assert.equal(isTossHeight(0.2, 'top', 33), false);
    assert.equal(isTossHeight(0.4, 'top', 33), true);
    assert.equal(isTossHeight(0.99, 'none', 33), true);

    const wa = {x: 0, y: 0, width: 1600, height: 1000};
    assert.deepEqual(tossSpan(wa, 'bottom', 30), {y: 0, height: 700});
    assert.deepEqual(tossSpan(wa, 'top', 30), {y: 300, height: 700});
    assert.deepEqual(tossSpan(wa, 'none', 30), {y: 0, height: 1000});
});

test('computeTargets: right is nearest first and marks the empty last one as new', () => {
    const t = computeTargets({activeIndex: 1, count: 4, side: 'right', dynamic: true, lastIsEmpty: true, windowAlone: false});
    assert.deepEqual(t, [{index: 2, isNew: false}, {index: 3, isNew: true}]);
});

test('computeTargets: left is nearest first and ends with a new workspace', () => {
    const t = computeTargets({activeIndex: 2, count: 4, side: 'left', dynamic: true, lastIsEmpty: true, windowAlone: false});
    assert.deepEqual(t.map(x => x.index), [1, 0, -1]);
});

test('computeTargets: static workspaces end at the boundary', () => {
    const args = {count: 4, dynamic: false, lastIsEmpty: true, windowAlone: false};
    assert.deepEqual(computeTargets({...args, activeIndex: 3, side: 'right'}), []);
    assert.deepEqual(computeTargets({...args, activeIndex: 0, side: 'left'}), []);
    assert.equal(computeTargets({...args, activeIndex: 2, side: 'right'})[0].isNew, false);
});

test('computeTargets: a lone window has no use for a new workspace', () => {
    const args = {count: 2, dynamic: true, lastIsEmpty: true, windowAlone: true, activeIndex: 0};
    assert.deepEqual(computeTargets({...args, side: 'right'}), []);
    assert.deepEqual(computeTargets({...args, side: 'left'}), []);
});

test('layoutPicker: many workspaces shrink to fit, few keep full size', () => {
    const workArea = {x: 0, y: 32, width: 1600, height: 968};
    const few = layoutPicker({count: 2, pointerY: 300, workArea, aspect: 1.6});
    assert.equal(few.cardWidth, 208);

    const many = layoutPicker({count: 20, pointerY: 300, workArea, aspect: 1.6});
    assert.ok(many.cardWidth < 208);
    const last = many.rects.at(-1);
    assert.ok(last.y + last.height <= 1000);
    assert.ok(many.rects[0].y >= 32);
});

test('layoutPicker: stays on screen when the pointer is near the bottom', () => {
    const workArea = {x: 0, y: 32, width: 1600, height: 968};
    const l = layoutPicker({count: 4, pointerY: 990, workArea, aspect: 1.6});
    assert.ok(l.rects.at(-1).y + l.rects.at(-1).height <= 1000);
});

test('cardAt picks the nearest card and clamps past the ends', () => {
    const rects = [{y: 100, height: 100}, {y: 210, height: 100}];
    assert.equal(cardAt(0, rects), 0);
    assert.equal(cardAt(150, rects), 0);
    assert.equal(cardAt(260, rects), 1);
    assert.equal(cardAt(9000, rects), 1);
});

test('quick drop: goes to the next workspace and stays here', () => {
    const s = armedAt(session());
    assert.equal(s.phase, Phase.ARMED);
    assert.deepEqual(s.decide(), {target: {index: 1, isNew: false}, follow: false});
});

test('quick drop with Shift goes with the window', () => {
    assert.equal(armedAt(session()).decide(true).follow, true);
});

test('drop-action "follow" inverts Shift', () => {
    const s = armedAt(session({dropAction: 'follow'}));
    assert.equal(s.decide().follow, true);
    assert.equal(s.decide(true).follow, false);
});

test('a drag starting on the edge does nothing until it has left the edge', () => {
    const s = session();
    s.update(1599, 300, 0, single);
    s.update(1590, 310, 500, single);
    assert.equal(s.phase, Phase.IDLE);
    assert.equal(s.decide(), null);

    s.update(1000, 310, 600, single);
    s.update(1599, 310, 700, single);
    assert.equal(s.phase, Phase.ARMED);
});

test('the tiling part of the edge stays with GNOME', () => {
    const s = session();
    s.update(800, 900, 0, single);
    s.update(1599, 900, 10, single);
    assert.equal(s.phase, Phase.IDLE);
    assert.equal(s.decide(), null);
});

test('sliding along the edge into the tiling part disarms', () => {
    const s = armedAt(session());
    s.update(1599, 900, 10, single);
    assert.equal(s.phase, Phase.IDLE);
});

test('no targets on that side leaves the edge to GNOME', () => {
    const s = session({getTargets: () => []});
    s.update(800, 300, 0, single);
    s.update(1599, 300, 10, single);
    assert.equal(s.phase, Phase.IDLE);
});

test('holding opens the picker with the nearest workspace selected', () => {
    const s = armedAt(session());
    s.update(1599, 300, 200, single);
    assert.equal(s.phase, Phase.ARMED);
    assert.ok(s.holdProgress > 0.5 && s.holdProgress < 1);

    s.update(1599, 300, 360, single);
    assert.equal(s.phase, Phase.PICKER);
    assert.equal(s.selected, 0);
});

test('the nearest stays selected until the pointer moves', () => {
    const s = armedAt(session(), 1599, 640);
    s.update(1599, 640, 360, single);
    assert.equal(s.phase, Phase.PICKER);
    assert.notEqual(cardAt(640, s.layout.rects), -1);
    s.update(1599, 645, 400, single);
    assert.equal(s.selected, 0);
});

test('moving up and down the picker chooses a far workspace', () => {
    const s = armedAt(session());
    s.update(1599, 300, 360, single);
    const third = s.layout.rects[2];
    s.update(1599, third.y + 5, 400, single);
    assert.equal(s.selected, 2);
    assert.deepEqual(s.decide(), {target: {index: 3, isNew: true}, follow: false});
});

test('holding on a card switches to going with the window, and moving resets it', () => {
    const s = armedAt(session());
    s.update(1599, 300, 360, single);
    const second = s.layout.rects[1];
    s.update(1599, second.y + 5, 400, single);
    s.update(1599, second.y + 5, 1300, single);
    assert.equal(s.decide().follow, false);
    s.update(1599, second.y + 5, 1601, single);
    assert.equal(s.decide().follow, true);

    s.update(1599, s.layout.rects[0].y + 5, 1620, single);
    assert.equal(s.decide().follow, false);
});

test('dragging out of the picker cancels it and allows a normal move', () => {
    const s = armedAt(session());
    s.update(1599, 300, 360, single);
    assert.equal(s.phase, Phase.PICKER);
    s.update(1599 - s.layout.cardWidth - 100, 300, 400, single);
    assert.equal(s.phase, Phase.IDLE);
    assert.equal(s.decide(), null);
});

test('the bottom of the picker stays usable inside the tiling zone', () => {
    const s = armedAt(session());
    s.update(1599, 300, 360, single);
    s.update(1599, 950, 400, single);
    assert.equal(s.phase, Phase.PICKER);
    assert.equal(s.selected, s.targets.length - 1);
});

test('workspace changes during a drag rebuild the picker', () => {
    let targets = [{index: 1, isNew: false}, {index: 2, isNew: false}];
    const s = session({getTargets: () => targets});
    armedAt(s);
    s.update(1599, 300, 360, single);
    const version = s.targetsVersion;

    targets = [{index: 1, isNew: false}];
    s.invalidate();
    s.update(1599, 300, 370, single);
    assert.equal(s.targets.length, 1);
    assert.equal(s.targetsVersion, version + 1);

    targets = [];
    s.invalidate();
    s.update(1599, 300, 380, single);
    assert.equal(s.phase, Phase.IDLE);
});

test('the hint grows on the approach and skips sides with no targets', () => {
    const s = session();
    s.update(800, 300, 0, single);
    assert.equal(s.hint, null);
    s.update(1450, 300, 10, single);
    assert.equal(s.hint.side, 'right');
    const far = s.hint.strength;
    s.update(1530, 300, 20, single);
    assert.ok(s.hint.strength > far);

    const none = session({getTargets: () => []});
    none.update(800, 300, 0, single);
    none.update(1450, 300, 10, single);
    assert.equal(none.hint, null);
});
