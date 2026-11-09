import Adw from 'gi://Adw';

export function accentColor() {
    return Adw.StyleManager.get_default().get_accent_color_rgba();
}
