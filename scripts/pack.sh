#!/usr/bin/env bash
# Builds one zip per range of GNOME versions into dist/, each with only the code it runs:
#   49-51  this checkout as it is
#   47-48  plus compat/pre49, for the older Meta.Window maximize API
#   46     plus compat/46, which has no accent colour to follow
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCHEMA=schemas/org.gnome.shell.extensions.edge-toss.gschema.xml

build() {
    local name=$1 versions=$2
    shift 2
    local src="$ROOT/dist/$name/src"

    rm -rf "$ROOT/dist/$name"
    mkdir -p "$src/schemas"
    cp -r "$ROOT"/{extension.js,prefs.js,stylesheet.css,metadata.json,lib,prefs} "$src/"
    cp "$ROOT/$SCHEMA" "$src/schemas/"
    for overlay in "$@"; do
        cp -r "$ROOT/compat/$overlay/." "$src/"
    done
    python3 -c "import json,sys; m=json.load(open(sys.argv[1])); m['shell-version']=sys.argv[2].replace('\"','').split(','); json.dump(m,open(sys.argv[1],'w'),indent=2)" \
        "$src/metadata.json" "$versions"

    if [ "$name" = 46 ]; then
        sed -i 's/-st-accent-color/#3584e4/g; s/-st-accent-fg-color/#ffffff/g' "$src/stylesheet.css"
    fi

    (cd "$src" && gnome-extensions pack --force --out-dir="$ROOT/dist/$name" \
        --extra-source=lib --extra-source=prefs --schema="$SCHEMA" .)
    mv "$ROOT/dist/$name/edge-toss@aahil-khan.github.com.shell-extension.zip" \
        "$ROOT/dist/edge-toss-gnome-$name.zip"
    echo "dist/edge-toss-gnome-$name.zip  ($versions)"
}

rm -f "$ROOT"/dist/*.zip
build 49-51 '"49","50","51"'
build 47-48 '"47","48"' pre49
build 46 '"46"' pre49 46
