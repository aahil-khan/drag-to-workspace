// A plain GTK4 window with a header bar to drag. Usage: gjs -m client.js <title>
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const title = ARGV[0] ?? 'client';
const app = new Gtk.Application({
    application_id: `dev.edgetoss.Client.${title.replace(/\W/g, '')}`,
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
    const win = new Gtk.ApplicationWindow({application: app, title, default_width: 700, default_height: 480});
    win.set_titlebar(new Gtk.HeaderBar());
    win.set_child(new Gtk.Label({label: title}));
    win.present();
});
app.run([GLib.get_prgname()]);
