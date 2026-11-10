#!/usr/bin/env bash
# Inside a test container: installs a zip the way the Extensions site does, gives GNOME
# Shell the system services it won't start without, then runs the tests.
# Usage: container-run.sh <zip>
set -eu

mkdir -p /run/dbus /ext
dbus-daemon --config-file=/src/test/e2e/container-system-bus.conf --fork
gjs -m /src/test/e2e/container-services.js &

unzip -q "$1" -d /ext
glib-compile-schemas --strict /ext/schemas
gnome-shell --version

DTW_EXT_DIR=/ext /src/test/e2e/run.sh ${DTW_SCENARIOS:-single dual prefs}
