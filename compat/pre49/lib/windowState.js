// Meta.Window's maximize API for GNOME 48 and older. See lib/windowState.js.

import Meta from 'gi://Meta';

export function isMaximized(win) {
    return win.get_maximized() === Meta.MaximizeFlags.BOTH;
}

export function hasMaximizedState(win) {
    return win.get_maximized() !== 0;
}

export function maximize(win) {
    win.maximize(Meta.MaximizeFlags.BOTH);
}

export function unmaximize(win) {
    win.unmaximize(Meta.MaximizeFlags.BOTH);
}
