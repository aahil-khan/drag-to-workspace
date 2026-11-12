import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {moveZone} from './lib/logic.js';
import {excludedAppsPage} from './prefs/excludedApps.js';
import {comboRow, spinRow, switchRow} from './prefs/rows.js';
import {readZone, writeZone, ZoneEditor} from './prefs/zoneEditor.js';

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
    row.add_row(zoneSpinRow(settings, side, 'start', _('Zone Top (%)')));
    row.add_row(zoneSpinRow(settings, side, 'end', _('Zone Bottom (%)')));
    return row;
}

/** Greys out rows that only matter with one picker gesture. */
function whileGesture(settings, gesture, rows) {
    const sync = () => {
        const active = settings.get_string('picker-gesture') === gesture;
        rows.forEach(row => (row.sensitive = active));
    };
    sync();
    settings.connect('changed::picker-gesture', sync);
}

/** Runs the two holds at their real speed, since milliseconds are hard to imagine. */
function timingPreviewRow(settings) {
    const row = new Adw.ActionRow({
        title: _('Preview Timing'),
        subtitle: _('Plays both delays at their real speed'),
    });

    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, valign: Gtk.Align.CENTER, width_request: 150});
    const holdBar = new Gtk.ProgressBar();
    const followBar = new Gtk.ProgressBar();
    box.append(holdBar);
    box.append(followBar);
    row.add_suffix(box);

    const button = new Gtk.Button({label: _('Play'), valign: Gtk.Align.CENTER});
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
        const wait = Math.min(settings.get_int('follow-start-delay-ms'), follow / 2);
        const started = GLib.get_monotonic_time();
        tickId = box.add_tick_callback(() => {
            const elapsed = (GLib.get_monotonic_time() - started) / 1000;
            holdBar.fraction = Math.min(elapsed / hold, 1);
            followBar.fraction = Math.min(Math.max(elapsed - hold - wait, 0) / (follow - wait), 1);
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

export default class DragToWorkspacePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keeps it alive for as long as the window is open.
        window._settings = settings;
        window.set_default_size(680, 800);
        window.add(this._zonesPage(settings));
        window.add(this._behaviourPage(settings));
        window.add(this._timingPage(settings, window));
        window.add(excludedAppsPage(settings));
    }

    _zonesPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Zones'), icon_name: 'view-fullscreen-symbolic'});

        const editor = new Adw.PreferencesGroup({
            title: _('Move Zones'),
            description: _('Drop a window in a zone to move it to another workspace. Drag the white handles or the zone itself to adjust it.'),
        });
        const frame = new Gtk.Box({css_classes: ['card']});
        frame.append(new ZoneEditor(settings));
        editor.add(frame);
        page.add(editor);

        const edges = new Adw.PreferencesGroup({title: _('Screen Edges')});
        edges.add(switchRow(settings, 'link-edges', _('Use the Same Zone on Both Edges'), null));
        edges.add(edgeRow(settings, 'left', _('Left Edge')));
        edges.add(edgeRow(settings, 'right', _('Right Edge')));
        page.add(edges);

        // Linking takes the left edge's zone, so the two can't start out different.
        settings.connect('changed::link-edges', () => {
            if (settings.get_boolean('link-edges'))
                writeZone(settings, 'left', readZone(settings, 'left'));
        });

        const hold = new Adw.PreferencesGroup({
            title: _('Hold-Only Edges'),
            description: _('Windows pass through these edges all the time, so they need a longer hold. Dropping without choosing a workspace does what it normally would.'),
        });
        hold.add(switchRow(settings, 'top-edge', _('Top Edge'),
            _('Shows every workspace, on both sides of the current one')));
        hold.add(switchRow(settings, 'shared-edges', _('Edges Between Monitors'),
            _('Opens the workspace picker without crossing to the other monitor')));
        page.add(hold);

        const reach = new Adw.PreferencesGroup({title: _('Activation')});
        reach.add(spinRow(settings, 'edge-depth', _('Distance from Edge'),
            _('How close to the screen edge the pointer must be, in pixels. With a small value, windows tile near the edge and move when pushed right up to it.'),
            1, 150, 1));
        reach.add(comboRow(settings, 'monitors', _('Monitors'),
            _('Which monitors these edges work on'), [
                {value: 'all', label: _('All Monitors')},
                {value: 'primary', label: _('Primary Only')},
            ]));
        page.add(reach);
        return page;
    }

    _behaviourPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Behaviour'), icon_name: 'preferences-system-symbolic'});

        const drop = new Adw.PreferencesGroup({title: _('After Moving a Window')});
        drop.add(comboRow(settings, 'drop-action', _('When You Drop a Window'),
            _('What happens to your view when a window moves'), [
                {value: 'stay', label: _('Stay on This Workspace')},
                {value: 'follow', label: _('Go With the Window')},
            ]));
        page.add(drop);

        const swap = new Adw.PreferencesGroup({
            title: _('Doing the Opposite'),
            description: _('Ways to choose the other option for a single move'),
        });
        swap.add(comboRow(settings, 'picker-gesture', _('In the Workspace Picker'),
            _('Each workspace is split in two, with one part doing the opposite, or you hold over a workspace until it fills up'), [
                {value: 'split', label: _('Split')},
                {value: 'hold', label: _('Hold')},
                {value: 'off', label: _('Neither')},
            ]));
        const splitSide = comboRow(settings, 'split-side', _('Part That Does the Opposite'),
            _('The inner part is away from the screen edge, and the outer part is next to it'), [
                {value: 'inner', label: _('Inner')},
                {value: 'outer', label: _('Outer')},
            ]);
        const splitSize = spinRow(settings, 'split-percent', _('Size of That Part'),
            _('Percent of each workspace preview'), 20, 80, 5);
        whileGesture(settings, 'split', [splitSide, splitSize]);
        swap.add(splitSide);
        swap.add(splitSize);
        swap.add(comboRow(settings, 'follow-modifier', _('Hold a Key While Dropping'),
            _('Ctrl is recommended, as releasing Alt opens the menu bar in some apps'), [
                {value: 'ctrl', label: _('Ctrl')},
                {value: 'alt', label: _('Alt')},
                {value: 'none', label: _('None')},
            ]));
        swap.add(switchRow(settings, 'right-click-to-go', _('Right-Click While Dragging'),
            _('Moves the window right away and always takes you with it when you let go')));
        page.add(swap);

        const keys = new Adw.PreferencesGroup({title: _('While Dragging')});
        keys.add(switchRow(settings, 'number-keys', _('Number Keys Choose a Workspace'),
            _('Press 1 to 9 while dragging, then drop anywhere. Press the same number again to cancel.')));
        keys.add(comboRow(settings, 'app-modifier', _('Move All of an App’s Windows'),
            _('Hold this key while dropping to bring the app’s other windows on this workspace too. Has no effect if it’s the same key as above.'), [
                {value: 'alt', label: _('Alt')},
                {value: 'ctrl', label: _('Ctrl')},
                {value: 'none', label: _('None')},
            ]));
        page.add(keys);

        const targets = new Adw.PreferencesGroup({title: _('Workspaces')});
        targets.add(switchRow(settings, 'offer-new-workspace', _('Offer a New Workspace'),
            _('Lets you move a window to a new, empty workspace, at the end or right next to this one, when using dynamic workspaces')));
        page.add(targets);
        return page;
    }

    _timingPage(settings, window) {
        const page = new Adw.PreferencesPage({title: _('Look & Feel'), icon_name: 'preferences-system-time-symbolic'});

        const timing = new Adw.PreferencesGroup({title: _('Timing')});
        timing.add(spinRow(settings, 'hold-delay-ms', _('Workspace Picker Delay'),
            _('Time to hold at the edge before the picker opens, in milliseconds. Dropping sooner moves the window to the next workspace.'), 100, 1500, 50));
        const follow = spinRow(settings, 'follow-delay-ms', _('Hold Over Workspace Time'),
            _('Time for a workspace in the picker to fill up, in milliseconds'), 200, 3000, 50);
        timing.add(follow);
        const followStart = spinRow(settings, 'follow-start-delay-ms', _('Wait Before Filling'),
            _('Time over a workspace before it starts to fill, in milliseconds, so that moving past workspaces doesn\u2019t start it'), 0, 1000, 25);
        timing.add(followStart);
        whileGesture(settings, 'hold', [follow, followStart]);
        timing.add(timingPreviewRow(settings));
        page.add(timing);

        const look = new Adw.PreferencesGroup({title: _('Appearance')});
        look.add(spinRow(settings, 'card-width', _('Workspace Preview Size'),
            _('Maximum width in pixels. Previews shrink to fit when there are many workspaces.'), 120, 360, 8));
        look.add(switchRow(settings, 'show-workspace-names', _('Show Workspace Names'),
            _('Adds any names you’ve given your workspaces to their previews')));
        look.add(switchRow(settings, 'show-app-icons', _('Show App Icons'),
            _('Shows which apps are on each workspace')));
        look.add(switchRow(settings, 'show-hint', _('Highlight Zones While Dragging'),
            _('Shows a thin bar along the edge as a window gets close')));
        look.add(switchRow(settings, 'animate-throw', _('Animate Moved Windows'),
            _('The window slides off the edge of the screen')));
        page.add(look);

        const popup = new Adw.PreferencesGroup({
            title: _('After a Move'),
            description: _('A small popup that says where a window went'),
        });
        popup.add(switchRow(settings, 'show-confirmation', _('Show a Popup'),
            _('Not shown when you go with the window')));
        const popupRows = [
            spinRow(settings, 'popup-duration-ms', _('How Long It Stays'),
                _('In milliseconds. It stays longer while the pointer is on it.'), 1000, 15000, 500),
            comboRow(settings, 'popup-buttons', _('Buttons'),
                _('Undo puts the window back, and Go takes you to it'), [
                    {value: 'both', label: _('Undo and Go')},
                    {value: 'undo', label: _('Undo Only')},
                    {value: 'go', label: _('Go Only')},
                    {value: 'none', label: _('None')},
                ]),
            comboRow(settings, 'popup-position', _('Where It Appears'), null, [
                {value: 'edge', label: _('At the Edge')},
                {value: 'pointer', label: _('Near the Pointer')},
                {value: 'top', label: _('Top of the Screen')},
            ]),
        ];
        for (const row of popupRows) {
            settings.bind('show-confirmation', row, 'sensitive', Gio.SettingsBindFlags.GET);
            popup.add(row);
        }
        page.add(popup);

        const reset = new Adw.PreferencesGroup();
        const resetRow = new Adw.ActionRow({title: _('Reset All Settings'), activatable: true});
        resetRow.connect('activated', () => {
            for (const key of settings.settings_schema.list_keys())
                settings.reset(key);
            window.add_toast(new Adw.Toast({title: _('Settings reset to defaults')}));
        });
        reset.add(resetRow);
        page.add(reset);
        return page;
    }
}
