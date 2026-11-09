import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function comboRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(c => c.label)),
    });
    const sync = () => {
        row.selected = Math.max(choices.findIndex(c => c.value === settings.get_string(key)), 0);
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const value = choices[row.selected].value;
        if (settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class EdgeTossPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const edge = new Adw.PreferencesGroup({
            title: 'Sharing the edge with half-tiling',
            description: 'Edges between two monitors always keep GNOME’s tiling. Super+Left and Super+Right work as usual.',
        });
        edge.add(comboRow(settings, 'tile-zone', 'Part of the edge that still half-tiles',
            'Dropping anywhere else on the left or right edge throws the window', [
                {value: 'bottom', label: 'Bottom'},
                {value: 'top', label: 'Top'},
                {value: 'none', label: 'None (the whole edge throws)'},
            ]));
        edge.add(spinRow(settings, 'tile-zone-size', 'Size of that part',
            'Percent of the edge’s height', 10, 60, 1));
        page.add(edge);

        const drop = new Adw.PreferencesGroup({title: 'Dropping'});
        drop.add(comboRow(settings, 'drop-action', 'A normal drop',
            'Holding Shift on drop, or holding on a workspace in the picker, does the opposite', [
                {value: 'stay', label: 'Stay here'},
                {value: 'follow', label: 'Go with it'},
            ]));
        page.add(drop);

        const timing = new Adw.PreferencesGroup({title: 'Timing'});
        timing.add(spinRow(settings, 'hold-delay-ms', 'Hold to open the picker',
            'Milliseconds at the edge', 100, 1500, 50));
        timing.add(spinRow(settings, 'follow-delay-ms', 'Hold on a workspace to switch action',
            'Milliseconds on one workspace in the picker', 200, 3000, 50));
        page.add(timing);
    }
}
