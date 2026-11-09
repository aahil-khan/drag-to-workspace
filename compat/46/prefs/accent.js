// GNOME 46 has no accent colour setting, so this is its one fixed blue.

import Gdk from 'gi://Gdk';

export function accentColor() {
    const color = new Gdk.RGBA();
    color.parse('#3584e4');
    return color;
}
