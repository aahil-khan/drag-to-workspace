import test from 'node:test';
import assert from 'node:assert/strict';

import {
    Phase, findEdge, isTossHeight, tossSpan, moveZone, zonePartAt, captionFor,
    computeTargets, layoutPicker, layoutStrip, cardAt, DragSession,
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

test('isTossHeight and tossSpan agree on the zone', () => {
    const zone = {start: 0.4, end: 0.7};
    assert.equal(isTossHeight(0.39, zone), false);
    assert.equal(isTossHeight(0.4, zone), true);
    assert.equal(isTossHeight(0.69, zone), true);
    assert.equal(isTossHeight(0.7, zone), false);
    assert.equal(isTossHeight(1, {start: 0, end: 1}), true);

    assert.deepEqual(tossSpan({x: 0, y: 100, width: 1600, height: 1000}, zone), {y: 500, height: 300});
});

test('moveZone: handles stop short of each other and of the ends', () => {
    const zone = {start: 20, end: 60};
    assert.deepEqual(moveZone(zone, 'start', 30.4), {start: 30, end: 60});
    assert.deepEqual(moveZone(zone, 'start', 90), {start: 55, end: 60});
    assert.deepEqual(moveZone(zone, 'start', -10), {start: 0, end: 60});
    assert.deepEqual(moveZone(zone, 'end', 5), {start: 20, end: 25});
    assert.deepEqual(moveZone(zone, 'end', 140), {start: 20, end: 100});
});

test('moveZone: sliding the body keeps its size', () => {
    const zone = {start: 20, end: 60};
    assert.deepEqual(moveZone(zone, 'body', 50), {start: 50, end: 90});
    assert.deepEqual(moveZone(zone, 'body', 90), {start: 60, end: 100});
    assert.deepEqual(moveZone(zone, 'body', -5), {start: 0, end: 40});
});

test('zonePartAt: finds the nearest handle, then the body, then nothing', () => {
    const zone = {start: 20, end: 60};
    assert.equal(zonePartAt(22, zone, 4), 'start');
    assert.equal(zonePartAt(58, zone, 4), 'end');
    assert.equal(zonePartAt(40, zone, 4), 'body');
    assert.equal(zonePartAt(80, zone, 4), null);
    assert.equal(zonePartAt(21, {start: 20, end: 25}, 4), 'start');
    assert.equal(zonePartAt(24, {start: 20, end: 25}, 4), 'end');
});

test('captionFor says what a drop does, and what holding on will do', () => {
    const stay = {dropAction: 'stay', cardWidth: 208};
    assert.equal(captionFor({...stay, followProgress: 0, flipped: false}), 'send');
    assert.equal(captionFor({...stay, followProgress: 0.5, flipped: false}), 'hold-go');
    assert.equal(captionFor({...stay, followProgress: 1, flipped: true}), 'go');
    assert.equal(captionFor({...stay, cardWidth: 104, followProgress: 0.5, flipped: false}), 'hold');

    const follow = {dropAction: 'follow', cardWidth: 208};
    assert.equal(captionFor({...follow, followProgress: 0, flipped: false}), 'go');
    assert.equal(captionFor({...follow, followProgress: 0.5, flipped: false}), 'hold-stay');
    assert.equal(captionFor({...follow, followProgress: 1, flipped: true}), 'send');
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

test('computeTargets: new workspaces can be turned off', () => {
    const args = {count: 3, dynamic: true, lastIsEmpty: true, windowAlone: false, offerNew: false};
    assert.deepEqual(computeTargets({...args, activeIndex: 1, side: 'right'}), []);
    assert.deepEqual(computeTargets({...args, activeIndex: 1, side: 'left'}), [{index: 0, isNew: false}]);
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

test('quick drop with the modifier goes with the window', () => {
    assert.equal(armedAt(session()).decide(true).follow, true);
});

test('a right-click goes with the window, whatever else is going on', () => {
    assert.equal(armedAt(session()).decide(false, true).follow, true);
    assert.equal(armedAt(session({dropAction: 'follow'})).decide(true, true).follow, true);
    assert.equal(session().decide(false, true), null);
});

test('drop-action "follow" inverts the modifier', () => {
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

test('a custom zone: only that part of the edge arms', () => {
    const zones = {
        left: {enabled: true, start: 0, end: 1},
        right: {enabled: true, start: 0.4, end: 0.6},
    };
    const s = session({zones});
    s.update(800, 300, 0, single);
    s.update(1599, 300, 10, single);
    assert.equal(s.phase, Phase.IDLE);
    s.update(1599, 500, 20, single);
    assert.equal(s.phase, Phase.ARMED);
    s.update(1599, 700, 30, single);
    assert.equal(s.phase, Phase.IDLE);

    s.update(800, 950, 40, single);
    s.update(0, 950, 50, single);
    assert.equal(s.side, 'left');
});

test('a turned off edge neither arms nor hints', () => {
    const zones = {
        left: {enabled: true, start: 0, end: 1},
        right: {enabled: false, start: 0, end: 1},
    };
    const s = session({zones});
    s.update(800, 300, 0, single);
    s.update(1450, 300, 5, single);
    assert.equal(s.hint, null);
    s.update(1599, 300, 10, single);
    assert.equal(s.phase, Phase.IDLE);
    s.update(0, 300, 20, single);
    assert.equal(s.phase, Phase.ARMED);
});

test('monitors can be excluded', () => {
    const two = [mon(0, 0, 1600, 1000), mon(1600, 0, 1600, 1000)];
    const s = session({allowMonitor: i => i === 0});
    s.update(800, 300, 0, two);
    s.update(3199, 300, 10, two);
    assert.equal(s.phase, Phase.IDLE);
    s.update(0, 300, 20, two);
    assert.equal(s.phase, Phase.ARMED);
});

test('the edge depth decides how close the pointer has to be', () => {
    const shallow = session({band: 8});
    shallow.update(800, 300, 0, single);
    shallow.update(1570, 300, 10, single);
    assert.equal(shallow.phase, Phase.IDLE);
    shallow.update(1595, 300, 20, single);
    assert.equal(shallow.phase, Phase.ARMED);

    const deep = session({band: 120});
    deep.update(800, 300, 0, single);
    deep.update(1500, 300, 10, single);
    assert.equal(deep.phase, Phase.ARMED);
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

test('going with the window waits 500ms by default, then fills', () => {
    const s = armedAt(session({followDelay: 1500}));
    s.update(1599, 300, 360, single);
    s.update(1599, 300, 360 + 490, single);
    assert.equal(s.followProgress, 0);
    s.update(1599, 300, 360 + 500 + 500, single);
    assert.ok(Math.abs(s.followProgress - 0.5) < 0.001);
    s.update(1599, 300, 360 + 1500, single);
    assert.equal(s.followProgress, 1);
});

test('the wait before filling is configurable, and never takes over the whole hold', () => {
    const none = armedAt(session({followDelay: 1000, followStartDelay: 0}));
    none.update(1599, 300, 360, single);
    none.update(1599, 300, 360 + 100, single);
    assert.ok(Math.abs(none.followProgress - 0.1) < 0.001);

    const long = armedAt(session({followDelay: 400, followStartDelay: 900}));
    long.update(1599, 300, 360, single);
    long.update(1599, 300, 360 + 300, single);
    assert.ok(Math.abs(long.followProgress - 0.5) < 0.001);
});

test('going with the window loads up steadily after a short pause', () => {
    const s = armedAt(session({followDelay: 1250, followStartDelay: 250}));
    s.update(1599, 300, 360, single);
    s.update(1599, 300, 360 + 200, single);
    assert.equal(s.followProgress, 0);

    s.update(1599, 300, 360 + 250 + 500, single);
    assert.ok(Math.abs(s.followProgress - 0.5) < 0.001);
    assert.equal(s.isFlipped(), false);

    s.update(1599, 300, 360 + 1250, single);
    assert.equal(s.followProgress, 1);
    assert.equal(s.isFlipped(), true);
});

test('hold-to-follow can be turned off', () => {
    const s = armedAt(session({holdToFollow: false}));
    s.update(1599, 300, 360, single);
    s.update(1599, 300, 9000, single);
    assert.equal(s.followProgress, 0);
    assert.equal(s.decide().follow, false);
    assert.equal(s.decide(true).follow, true);
});

test('card size is configurable', () => {
    const s = armedAt(session({cardWidth: 300}));
    s.update(1599, 300, 360, single);
    assert.equal(s.layout.cardWidth, 300);
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

test('findEdge: shared and top edges only count when asked for', () => {
    const two = [mon(0, 0, 1600, 1000), mon(1600, 0, 1600, 1000)];
    const on = {sharedEdges: true, topEdge: true};
    assert.equal(findEdge(1599, 300, two, BAND), null);
    assert.equal(findEdge(1599, 300, two, BAND, on).kind, 'shared');
    assert.equal(findEdge(1599, 300, two, BAND, on).side, 'right');
    assert.equal(findEdge(1600, 300, two, BAND, on).side, 'left');
    assert.equal(findEdge(3199, 300, two, BAND, on).kind, 'outer');

    assert.equal(findEdge(800, 10, two, BAND), null);
    assert.equal(findEdge(800, 10, two, BAND, on).kind, 'top');
    assert.equal(findEdge(800, 33, two, BAND, on).kind, 'top');
    assert.equal(findEdge(800, 60, two, BAND, on), null);
});

test('findEdge: the top of a monitor below another is not an edge', () => {
    const stacked = [mon(0, 0, 1600, 1000), mon(0, 1000, 1600, 1000)];
    assert.equal(findEdge(800, 1010, stacked, BAND, {topEdge: true}), null);
    assert.equal(findEdge(800, 10, stacked, BAND, {topEdge: true}).kind, 'top');
});

test('computeTargets: top offers every other workspace in order', () => {
    const args = {activeIndex: 1, count: 4, side: 'top', dynamic: true, lastIsEmpty: true, windowAlone: false};
    assert.deepEqual(computeTargets(args).map(t => t.index), [0, 2, 3]);
    assert.equal(computeTargets(args).at(-1).isNew, true);
    assert.deepEqual(computeTargets({...args, offerNew: false}).map(t => t.index), [0, 2]);
});

test('layoutStrip: fits many workspaces across the top, centred', () => {
    const workArea = {x: 0, y: 32, width: 1600, height: 968};
    const few = layoutStrip({count: 2, workArea, aspect: 1.6});
    assert.equal(few.cardWidth, 208);
    assert.equal(few.rects[0].x - workArea.x, workArea.x + workArea.width - few.rects[1].x - few.cardWidth);

    const many = layoutStrip({count: 20, workArea, aspect: 1.6});
    assert.ok(many.cardWidth < 208);
    assert.ok(many.rects.at(-1).x + many.cardWidth <= 1600);
    assert.ok(many.rects[0].x >= 0);
});

test('cardAt: runs along either axis', () => {
    const rects = [{x: 0, y: 40, width: 100, height: 60}, {x: 110, y: 40, width: 100, height: 60}];
    assert.equal(cardAt(20, rects, 'x'), 0);
    assert.equal(cardAt(180, rects, 'x'), 1);
});

const dualMonitors = [mon(0, 0, 1600, 1000), mon(1600, 0, 1600, 1000)];
const softSession = (opts = {}) => session({sharedEdges: true, topEdge: true, ...opts});

test('a soft edge: passing through does nothing, and a quick drop stays GNOME\'s', () => {
    const s = softSession();
    s.update(800, 300, 0, dualMonitors);
    s.update(1599, 300, 10, dualMonitors);
    assert.equal(s.phase, Phase.ARMED);
    assert.equal(s.isSoft, true);
    assert.equal(s.showsTab, false);
    assert.equal(s.ownsPointer, false);
    assert.equal(s.decide(), null);

    s.update(1599, 300, 300, dualMonitors);
    assert.equal(s.showsTab, true);
    assert.equal(s.decide(), null);
    s.update(1700, 300, 310, dualMonitors);
    assert.equal(s.phase, Phase.IDLE);
});

test('a soft edge: the picker takes a longer hold and starts with nothing selected', () => {
    const s = softSession();
    s.update(800, 300, 0, dualMonitors);
    s.update(1599, 300, 10, dualMonitors);
    s.update(1599, 300, 400, dualMonitors);
    assert.equal(s.phase, Phase.ARMED);
    s.update(1599, 300, 720, dualMonitors);
    assert.equal(s.phase, Phase.PICKER);
    assert.equal(s.selected, -1);
    assert.equal(s.ownsPointer, false);
    assert.equal(s.decide(), null);
    s.update(1599, 300, 3000, dualMonitors);
    assert.equal(s.decide(), null);
    assert.equal(s.followProgress, 0);
});

test('a soft edge: moving over a card picks it, and then a drop moves the window', () => {
    const s = softSession();
    s.update(800, 300, 0, dualMonitors);
    s.update(1599, 300, 10, dualMonitors);
    s.update(1599, 300, 720, dualMonitors);
    const second = s.layout.rects[1];
    s.update(1599, second.y + 10, 800, dualMonitors);
    assert.equal(s.selected, 1);
    assert.equal(s.ownsPointer, true);
    assert.deepEqual(s.decide().target, s.targets[1]);
});

test('the top edge: a strip of cards, chosen by moving sideways', () => {
    const s = softSession();
    s.update(800, 300, 0, single);
    s.update(800, 10, 10, single);
    assert.equal(s.kind, 'top');
    assert.equal(s.decide(), null);
    s.update(800, 10, 720, single);
    assert.equal(s.phase, Phase.PICKER);
    assert.equal(s.selected, -1);

    const last = s.layout.rects.at(-1);
    s.update(last.x + 20, 10, 800, single);
    assert.equal(s.selected, s.targets.length - 1);
    assert.equal(s.decide().target.index, s.targets.at(-1).index);

    s.update(last.x + 20, s.layout.top + s.layout.cardHeight + 100, 900, single);
    assert.equal(s.phase, Phase.IDLE);
});

test('the top edge respects the monitor setting', () => {
    const s = softSession({allowMonitor: i => i === 1});
    s.update(800, 300, 0, dualMonitors);
    s.update(800, 10, 10, dualMonitors);
    assert.equal(s.phase, Phase.IDLE);
});

test('a number key chooses a workspace from anywhere, and again to take it back', () => {
    const all = [{index: 0, isNew: false}, {index: 2, isNew: false}, {index: 3, isNew: true}];
    const s = session({getTargets: () => all});
    s.update(800, 500, 0, single);
    assert.equal(s.decide(), null);

    s.chooseNumber(3);
    assert.equal(s.ownsPointer, true);
    assert.deepEqual(s.decide(), {target: all[1], follow: false});
    assert.equal(s.decide(true).follow, true);

    s.update(1599, 300, 100, single);
    assert.equal(s.phase, Phase.IDLE);
    assert.equal(s.decide().target.index, 2);

    s.chooseNumber(3);
    assert.equal(s.decide(), null);
});

test('a number key ignores workspaces that are not targets, like the current one', () => {
    const s = session({getTargets: () => [{index: 0, isNew: false}, {index: 2, isNew: false}]});
    s.update(800, 500, 0, single);
    s.chooseNumber(2);
    assert.equal(s.keyTarget, null);
    s.chooseNumber(9);
    assert.equal(s.keyTarget, null);
});

test('a number key closes an open picker', () => {
    const s = armedAt(session());
    s.update(1599, 300, 360, single);
    assert.equal(s.phase, Phase.PICKER);
    s.chooseNumber(2);
    assert.equal(s.phase, Phase.IDLE);
    assert.equal(s.decide().target.index, 1);
});

test('a chosen workspace that goes away is forgotten', () => {
    let all = [{index: 1, isNew: false}];
    const s = session({getTargets: () => all});
    s.update(800, 500, 0, single);
    s.chooseNumber(2);
    assert.equal(s.keyTarget.index, 1);
    all = [];
    s.invalidate();
    s.update(800, 500, 10, single);
    assert.equal(s.keyTarget, null);
});
