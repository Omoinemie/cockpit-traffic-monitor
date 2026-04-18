#!/bin/bash
# Build .deb package for cockpit-traffic-monitor
set -e

NAME="cockpit-traffic-monitor"
VERSION=$(grep -oP '"version":\s*"\K[0-9.]+' manifest.json)
INSTALL_DIR="/usr/share/cockpit/traffic-monitor"

echo "Building v${VERSION}"

# Sync version to index.html
sed -i "s|<span>v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*</span>|<span>v${VERSION}</span>|" index.html
echo "  index.html → v${VERSION}"

# Build .deb
PKG_DIR="pkg"
rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR/DEBIAN"
mkdir -p "$PKG_DIR${INSTALL_DIR}/src"
mkdir -p "$PKG_DIR${INSTALL_DIR}/po"

cp index.html manifest.json "$PKG_DIR${INSTALL_DIR}/"
cp src/* "$PKG_DIR${INSTALL_DIR}/src/"
cp po/*.json "$PKG_DIR${INSTALL_DIR}/po/"

INSTALLED_SIZE=$(du -sk "$PKG_DIR/usr" | cut -f1)

cat > "$PKG_DIR/DEBIAN/control" << EOF
Package: ${NAME}
Version: ${VERSION}
Section: admin
Priority: optional
Architecture: all
Depends: cockpit (>= 286), vnstat
Maintainer: admin <admin@localhost>
Description: Cockpit network interface traffic monitor
 Real-time traffic monitoring with multi-timespan charts,
 interface filtering, detail modal, dark/light theme.
Installed-Size: ${INSTALLED_SIZE}
EOF

cat > "$PKG_DIR/DEBIAN/postinst" << 'EOF'
#!/bin/sh
set -e
if [ "$1" = "configure" ]; then
  if systemctl is-active --quiet cockpit.socket 2>/dev/null; then
    systemctl reload cockpit 2>/dev/null || true
  fi
fi
EOF
chmod 755 "$PKG_DIR/DEBIAN/postinst"

OUTPUT="${NAME}_${VERSION}_all.deb"
dpkg-deb --build "$PKG_DIR" "$OUTPUT"
rm -rf "$PKG_DIR"

echo "Built: ${OUTPUT} ($(du -h "$OUTPUT" | cut -f1))"
