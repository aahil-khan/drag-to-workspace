#!/usr/bin/env bash
# Runs the end-to-end tests against each packaged zip, on the real distro it targets, in
# rootless containers. Usage: matrix.sh [--only "test name"] [distro...]
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MATRIX_OUT="$ROOT/test/e2e/out/matrix"

FEDORA_PKGS="gnome-shell mutter gjs gtk4 libadwaita dconf dbus-daemon glib2 mesa-dri-drivers adwaita-sans-fonts unzip"
DEBIAN_PKGS="gnome-shell gjs gir1.2-gtk-4.0 gir1.2-adw-1 dconf-cli dbus libglib2.0-bin libgl1-mesa-dri fonts-cantarell unzip"

# distro | image | GNOME | zip | packages
TARGETS=(
    "ubuntu-24.04|docker.io/library/ubuntu:24.04|46|46|apt"
    "fedora-41|registry.fedoraproject.org/fedora:41|47|47-48|dnf"
    "debian-13|docker.io/library/debian:13|48|47-48|apt"
    "fedora-43|registry.fedoraproject.org/fedora:43|49|49-51|dnf"
    "alma-10|quay.io/almalinuxorg/almalinux:10|49|49-51|dnf"
    "fedora-44|registry.fedoraproject.org/fedora:44|50|49-51|dnf"
    "ubuntu-26.04|docker.io/library/ubuntu:26.04|50|49-51|apt"
    "fedora-45|registry.fedoraproject.org/fedora:45|51|49-51|dnf"
)

# Errors from each distro's own GNOME build, reproduced by the "control" scenario with
# Drag to Workspace turned off. Anything else fails the run.
known_error() {
    case $1 in
        alma-10) echo 'record is undefined' ;;
        ubuntu-26.04) echo 'firstIcon.icon is null' ;;
    esac
}

BUILD_TIMEOUT=${DTW_BUILD_TIMEOUT:-1500}

only=""
if [ "${1:-}" = "--only" ]; then
    only=$2
    shift 2
fi
wanted=" $* "

# A retired Fedora's mirror list is mostly dead ends, so go straight to the archive.
archive_repos() {
    case $1 in
        *fedora:41)
            local archive='https://dl.fedoraproject.org/pub/archive/fedora/linux'
            echo "sed -i 's|^metalink=.*|baseurl=$archive/releases/41/Everything/x86_64/os/|' /etc/yum.repos.d/fedora.repo && sed -i 's|^metalink=.*|baseurl=$archive/updates/41/Everything/x86_64/|' /etc/yum.repos.d/fedora-updates.repo && "
            ;;
    esac
}

build_image() {
    local tag=$1 base=$2 manager=$3
    if [ "$manager" = apt ]; then
        timeout "$BUILD_TIMEOUT" podman build -q -t "$tag" - <<EOF
FROM $base
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $DEBIAN_PKGS
EOF
    else
        timeout "$BUILD_TIMEOUT" podman build -q -t "$tag" - <<EOF
FROM $base
RUN $(archive_repos "$base")dnf install -y --setopt=install_weak_deps=False --setopt=strict=0 $FEDORA_PKGS
EOF
    fi
}

mkdir -p "$MATRIX_OUT"
summary=()
status=0

for target in "${TARGETS[@]}"; do
    IFS='|' read -r distro base gnome zip manager <<<"$target"
    if [ "$wanted" != "  " ] && [[ "$wanted" != *" $distro "* ]]; then
        continue
    fi

    tag="localhost/drag-to-workspace-test:$distro"
    out="$MATRIX_OUT/$distro"
    rm -rf "$out"
    mkdir -p "$out"

    echo "=== $distro (GNOME $gnome), $zip build"
    if ! podman image exists "$tag" && ! build_image "$tag" "$base" "$manager"; then
        summary+=("$distro  GNOME $gnome  IMAGE BUILD FAILED")
        status=1
        continue
    fi

    podman run --rm --network=none --security-opt label=disable --device /dev/dri \
        -v "$ROOT:/src:ro" -v "$out:/out" \
        -e DTW_ONLY="$only" -e DTW_NO_REPORT=1 -e DTW_PREFS_BASIC=1 \
        -e DTW_SCENARIOS="${DTW_SCENARIOS:-single dual prefs}" -e DTW_E2E_OUT=/out -e DTW_TIMEOUT="${DTW_TIMEOUT:-580}" \
        "$tag" /src/test/e2e/container-run.sh "/src/dist/drag-to-workspace-gnome-$zip.zip" >"$out/run.log" 2>&1

    version=$(grep -m1 -E '^GNOME Shell ' "$out/run.log" || echo 'version unknown')
    line="$distro  $version"
    for scenario in ${DTW_SCENARIOS:-single dual prefs}; do
        if report=$(DTW_KNOWN_ERROR="$(known_error "$distro")" node "$ROOT/test/e2e/report.mjs" "$out/results-$scenario.json" "$out/shell-$scenario.log" 2>&1); then
            line+="  $scenario: $(echo "$report" | tail -1)"
        else
            status=1
            line+="  $scenario: FAILED"
            echo "$report" | cut -c1-180 | grep -v '^pass' | tail -25
        fi
    done
    echo "$line"
    summary+=("$line")
done

echo
echo "===== summary"
printf '%s\n' "${summary[@]}"
exit $status
