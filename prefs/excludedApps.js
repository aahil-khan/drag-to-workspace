// The list of apps whose windows are never moved, and the dialog for adding to it.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const KEY = 'excluded-apps';

function appIcon(app) {
    return new Gtk.Image({gicon: app?.get_icon() ?? null, pixel_size: 32, css_classes: ['lowres-icon']});
}

function chooseApp(parent, excluded, onChosen) {
    const dialog = new Adw.Dialog({title: _('Add an App'), content_width: 420, content_height: 520});

    const list = new Gtk.ListBox({css_classes: ['boxed-list'], selection_mode: Gtk.SelectionMode.NONE});
    const apps = Gio.AppInfo.get_all()
        .filter(app => app.should_show() && !excluded.includes(app.get_id()))
        .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));

    for (const app of apps) {
        const row = new Adw.ActionRow({title: GLib.markup_escape_text(app.get_display_name(), -1), activatable: true});
        row.add_prefix(appIcon(app));
        row.connect('activated', () => {
            onChosen(app.get_id());
            dialog.close();
        });
        row._searchText = app.get_display_name().toLowerCase();
        list.append(row);
    }

    const search = new Gtk.SearchEntry({placeholder_text: _('Search apps'), margin_bottom: 12});
    search.connect('search-changed', () => list.invalidate_filter());
    list.set_filter_func(row => row._searchText.includes(search.text.toLowerCase()));

    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        margin_top: 6,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });
    content.append(search);
    content.append(new Gtk.ScrolledWindow({
        child: list,
        vexpand: true,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
    }));

    const view = new Adw.ToolbarView({content});
    view.add_top_bar(new Adw.HeaderBar());
    dialog.child = view;
    dialog.present(parent);
}

export function excludedAppsPage(settings) {
    const page = new Adw.PreferencesPage({title: _('Apps'), icon_name: 'view-app-grid-symbolic'});
    const group = new Adw.PreferencesGroup({
        title: _('Excluded Apps'),
        description: _('Windows of these apps can be dragged to the screen edges as usual, but never move to another workspace.'),
    });
    page.add(group);

    const addButton = new Gtk.Button({
        icon_name: 'list-add-symbolic',
        tooltip_text: _('Add an App'),
        css_classes: ['flat'],
        valign: Gtk.Align.CENTER,
    });
    addButton.connect('clicked', () => {
        const excluded = settings.get_strv(KEY);
        chooseApp(page.get_root(), excluded, id => settings.set_strv(KEY, [...excluded, id]));
    });
    group.set_header_suffix(addButton);

    let rows = [];
    const rebuild = () => {
        rows.forEach(row => group.remove(row));
        rows = settings.get_strv(KEY).map(id => {
            const app = Gio.DesktopAppInfo.new(id);
            const row = new Adw.ActionRow({title: GLib.markup_escape_text(app?.get_display_name() ?? id, -1)});
            row.add_prefix(appIcon(app));

            const remove = new Gtk.Button({
                icon_name: 'edit-delete-symbolic',
                tooltip_text: _('Remove'),
                css_classes: ['flat'],
                valign: Gtk.Align.CENTER,
            });
            remove.connect('clicked', () => {
                settings.set_strv(KEY, settings.get_strv(KEY).filter(other => other !== id));
            });
            row.add_suffix(remove);
            return row;
        });
        if (rows.length === 0)
            rows = [new Adw.ActionRow({title: _('No apps excluded')})];
        rows.forEach(row => group.add(row));
    };
    rebuild();
    settings.connect(`changed::${KEY}`, rebuild);
    return page;
}
