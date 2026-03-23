#!/usr/bin/env bash
# Create portable tarball with start.sh
# Used by both test-build-docker.sh and GitHub Actions release.yml
set -e

VERSION="${1:-$(jq -r '.version' src-tauri/tauri.conf.json)}"
BUNDLE_DIR="src-tauri/target/release/bundle"
APPDIR="$BUNDLE_DIR/appimage/Penguin Citizen.AppDir"
TARBALL_NAME="penguin-citizen_${VERSION}_amd64_portable"
STAGING_DIR="$BUNDLE_DIR/$TARBALL_NAME"

if [ ! -d "$APPDIR/usr" ]; then
    echo "ERROR: AppDir not found at $APPDIR/usr"
    exit 1
fi

echo "Creating portable tarball..."

mkdir -p "$STAGING_DIR"
cp -a "$APPDIR/usr" "$STAGING_DIR/"
for f in "$APPDIR"/*.desktop "$APPDIR"/*.png; do
    [ -e "$f" ] && cp -a "$f" "$STAGING_DIR/"
done

# Create start.sh with proper shell variable handling
cat > "$STAGING_DIR/start.sh" << 'SCRIPT_EOF'
#!/usr/bin/env bash
set -e
HERE="$(dirname "$(readlink -f "$0")")"
gsettings get org.gnome.desktop.interface gtk-theme 2>/dev/null | grep -qi dark && GTK_THEME_VARIANT=dark || GTK_THEME_VARIANT=light
export LD_LIBRARY_PATH="/usr/lib:/usr/lib64:$HERE/usr/lib:$HERE/usr/lib/x86_64-linux-gnu:$HERE/usr/lib64:$HERE/usr/lib32:$HERE/lib:$HERE/lib/x86_64-linux-gnu"
export PATH="$HERE/usr/bin:$PATH"
export GTK_DATA_PREFIX="$HERE"
export GTK_THEME="Adwaita:$GTK_THEME_VARIANT"
export GDK_BACKEND=x11
export XDG_DATA_DIRS="$HERE/usr/share:/usr/share:/usr/local/share:/usr/share"
export GSETTINGS_SCHEMA_DIR="$HERE/usr/share/glib-2.0/schemas"
export GTK_EXE_PREFIX="$HERE"
export GTK_PATH="$HERE/usr/lib/gtk-3.0:/usr/lib64/gtk-3.0:/usr/lib/x86_64-linux-gnu/gtk-3.0"
export GTK_IM_MODULE_FILE="$HERE/usr/lib/gtk-3.0/3.0.0/immodules.cache"
export GDK_PIXBUF_MODULE_FILE="$HERE/usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"
export GIO_EXTRA_MODULES="$HERE/usr/lib/gio/modules"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DISPLAY="${DISPLAY:-:0}"
cd "$HERE/usr"
exec "$HERE/usr/bin/penguin-citizen" "$@"
SCRIPT_EOF

chmod +x "$STAGING_DIR/start.sh"

tar czf "$BUNDLE_DIR/${TARBALL_NAME}.tar.gz" -C "$BUNDLE_DIR" "$TARBALL_NAME"
rm -rf "$STAGING_DIR"
echo "Portable tarball created: ${TARBALL_NAME}.tar.gz"
