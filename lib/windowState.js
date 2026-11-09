// The Meta.Window maximize API changed in GNOME 49. This file is the only place that
// differs: the build for older versions swaps in compat/pre49/lib/windowState.js.

export function isMaximized(win) {
    return win.is_maximized();
}

export function hasMaximizedState(win) {
    return win.get_maximize_flags() !== 0;
}

export function maximize(win) {
    win.maximize();
}

export function unmaximize(win) {
    win.unmaximize();
}
