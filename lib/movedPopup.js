// The small popup after a move, saying where the window went, with Undo and Go buttons.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const SHOWN_MS = 4000;
const FADE_MS = 200;

export const MovedPopup = GObject.registerClass(
class EdgeTossMovedPopup extends St.BoxLayout {
    constructor({text, onUndo, onGo, onClosed}) {
        super({style_class: 'edge-toss-popup', reactive: true, track_hover: true});
        this._onClosed = onClosed;
        this._timeoutId = 0;

        this.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
        this.add_child(this._button(_('Undo'), onUndo));
        this.add_child(this._button(_('Go'), onGo));

        // It needs input, so it has to be chrome rather than part of the overlay.
        Main.layoutManager.addTopChrome(this);

        this.connect('notify::hover', () => this._startTimeout());
        this.connect('destroy', () => this._stopTimeout());
        this._startTimeout();
    }

    _button(label, onClicked) {
        const button = new St.Button({style_class: 'edge-toss-popup-button', label});
        button.connect('clicked', () => {
            onClicked();
            this.close();
        });
        return button;
    }

    /** Stays while the pointer is on it, then gives you the full time again after. */
    _startTimeout() {
        this._stopTimeout();
        if (this.hover)
            return;

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHOWN_MS, () => {
            this._timeoutId = 0;
            this.ease({
                opacity: 0,
                duration: FADE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: finished => {
                    if (finished)
                        this.close();
                },
            });
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._timeoutId, '[edge-toss] moved popup');
    }

    _stopTimeout() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    close() {
        this._onClosed();
        Main.layoutManager.removeChrome(this);
        this.destroy();
    }
});
