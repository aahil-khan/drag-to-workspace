#!/usr/bin/env bash
# Installs or updates Drag to Workspace for the current user:
#   curl -fsSL https://raw.githubusercontent.com/aahil-khan/drag-to-workspace/main/get.sh | bash
# It picks the zip for your GNOME Shell version from the latest release,
# installs it into ~/.local/share/gnome-shell/extensions, and turns it on.
# Nothing is installed system-wide, and no other extension is touched.
set -euo pipefail

UUID=drag-to-workspace@aahil-khan.github.com
REPO=aahil-khan/drag-to-workspace
RELEASES=${DTW_RELEASES:-https://github.com/$REPO/releases/latest/download}

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "run this as yourself, not with sudo. Extensions are installed per user."

for tool in gnome-shell gnome-extensions gsettings unzip; do
    command -v "$tool" >/dev/null || die "$tool was not found. This needs a GNOME desktop with unzip installed."
done

if command -v curl >/dev/null; then
    fetch() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null; then
    fetch() { wget -q -O "$2" "$1"; }
else
    die "neither curl nor wget was found."
fi

version=$(gnome-shell --version | grep -oE '[0-9]+' | head -n1)
case "$version" in
    46) range=46 ;;
    47 | 48) range=47-48 ;;
    49 | 50 | 51) range=49-51 ;;
    *) die "GNOME Shell $version isn't supported. Drag to Workspace runs on GNOME 46 to 51." ;;
esac

target="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
if [ -L "$target" ]; then
    die "$target is a symlink, probably to a checkout from 'make install'. Remove it first if you want the release instead."
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
zip="drag-to-workspace-gnome-$range.zip"

say "Downloading $zip for GNOME $version..."
fetch "$RELEASES/$zip" "$tmp/$zip" || die "couldn't download $RELEASES/$zip"

# Make sure it's the extension we expect before installing it.
unzip -tq "$tmp/$zip" >/dev/null || die "the download isn't a valid zip."
unzip -p "$tmp/$zip" metadata.json | grep -q "\"uuid\": *\"$UUID\"" ||
    die "the download doesn't contain $UUID."

updating=false
[ -d "$target" ] && updating=true

gnome-extensions install --force "$tmp/$zip"

# GNOME Shell only notices a new extension at login, so 'gnome-extensions enable'
# can't see it yet. Add it to the list of enabled extensions directly instead.
enabled=$(gsettings get org.gnome.shell enabled-extensions)
if [[ "$enabled" != *"'$UUID'"* ]]; then
    if [[ "$enabled" == *"[]" ]]; then
        enabled="['$UUID']"
    else
        enabled="${enabled%]}, '$UUID']"
    fi
    gsettings set org.gnome.shell enabled-extensions "$enabled"
fi

if [ "$(gsettings get org.gnome.shell disable-user-extensions)" = true ]; then
    say ""
    say "Note: user extensions are turned off. Turn on \"Use Extensions\" in the Extensions app, or it won't load."
fi

say ""
if $updating; then
    say "Updated Drag to Workspace. Your settings are kept."
else
    say "Installed Drag to Workspace."
fi
if [ "${XDG_SESSION_TYPE:-}" = x11 ] && [ "$version" -lt 49 ]; then
    say "Press Alt+F2, type r and press Enter to restart GNOME Shell, and it will start."
else
    say "Log out and back in, and it will start."
fi
say "Settings: gnome-extensions prefs $UUID"
