#!/usr/bin/env bash
# Real drags in a throwaway headless GNOME Shell. HOME, config, data, runtime dir and
# the session bus are all sandboxed, so the running desktop and its dconf stay untouched.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${EDGE_TOSS_E2E_OUT:-$ROOT/test/e2e/out}
UUID=edge-toss@aahil-khan.github.com
DRIVER=edge-toss-driver@test
status=0

run_scenario() {
    local scenario=$1; shift
    local sandbox
    # Inside the repo's ignored output dir: Wayland socket paths are limited to 108 bytes.
    mkdir -p "$OUT"
    sandbox=$(mktemp -d "$OUT/sb.XXXXXX")
    # shellcheck disable=SC2064
    trap "rm -rf '$sandbox'" RETURN

    mkdir -p "$sandbox"/{home,config,cache,runtime,data/gnome-shell/extensions} "$OUT"
    chmod 700 "$sandbox/runtime"
    # EDGE_TOSS_EXT_DIR tests a built package instead of this checkout.
    ln -s "${EDGE_TOSS_EXT_DIR:-$ROOT}" "$sandbox/data/gnome-shell/extensions/$UUID"
    ln -s "$ROOT/test/e2e/driver" "$sandbox/data/gnome-shell/extensions/$DRIVER"
    rm -f "$OUT/results-$scenario.json"

    env -i \
        PATH="$PATH" LANG="${LANG:-C.UTF-8}" \
        HOME="$sandbox/home" \
        XDG_CONFIG_HOME="$sandbox/config" \
        XDG_CACHE_HOME="$sandbox/cache" \
        XDG_DATA_HOME="$sandbox/data" \
        XDG_RUNTIME_DIR="$sandbox/runtime" \
        XDG_DATA_DIRS=/usr/local/share:/usr/share \
        XDG_SESSION_TYPE=wayland \
        XDG_CURRENT_DESKTOP=GNOME \
        WAYLAND_DISPLAY=edge-toss-test \
        EDGE_TOSS_OUT="$OUT" \
        EDGE_TOSS_SCENARIO="$scenario" \
        EDGE_TOSS_ONLY="${EDGE_TOSS_ONLY:-}" \
        EDGE_TOSS_PREFS_BASIC="${EDGE_TOSS_PREFS_BASIC:-}" \
        EDGE_TOSS_CLIENT="$ROOT/test/e2e/client.js" \
        dbus-run-session -- bash -c '
            dconf write /org/gnome/shell/enabled-extensions "[\"'"$UUID"'\", \"'"$DRIVER"'\"]"
            dconf write /org/gnome/shell/disable-user-extensions false
            dconf write /org/gnome/shell/welcome-dialog-last-shown-version "\"999\""
            dconf write /org/gnome/mutter/dynamic-workspaces true
            dconf write /org/gnome/mutter/edge-tiling true
            dconf write /org/gnome/desktop/interface/enable-hot-corners false
            exec timeout --kill-after=10 '"${EDGE_TOSS_TIMEOUT:-300}"' gnome-shell --headless --no-x11 --force-animations \
                --wayland-display=edge-toss-test "$@"
        ' _ "$@" >"$OUT/shell-$scenario.log" 2>&1 || true

    # In a container there's no node, and the matrix reports from the host instead.
    if [ -z "${EDGE_TOSS_NO_REPORT:-}" ] && ! node "$ROOT/test/e2e/report.mjs" "$OUT/results-$scenario.json" "$OUT/shell-$scenario.log"; then
        status=1
    fi
}

scenarios=${*:-single dual}
for s in $scenarios; do
    case $s in
        single) run_scenario single --virtual-monitor 1600x1000 ;;
        prefs) run_scenario prefs --virtual-monitor 1600x1000 ;;
        control) run_scenario control --virtual-monitor 1600x1000 ;;
        dual) run_scenario dual --virtual-monitor 1280x800 --virtual-monitor 1280x800 ;;
        *) echo "unknown scenario: $s" >&2; exit 2 ;;
    esac
done
exit $status
