#!/bin/bash
# Build .deb package for cockpit-traffic-monitor
set -e

VERSION=$(grep '"version"' manifest.json | grep -oP '[\d.]+')
NAME="cockpit-traffic-monitor"
PKG_DIR="pkg"
INSTALL_DIR="/usr/share/cockpit/traffic-monitor"

rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR/DEBIAN"
mkdir -p "$PKG_DIR${INSTALL_DIR}/src"

cp index.html "$PKG_DIR${INSTALL_DIR}/"
cp manifest.json "$PKG_DIR${INSTALL_DIR}/"
cp src/style.css "$PKG_DIR${INSTALL_DIR}/src/"
cp src/app.js "$PKG_DIR${INSTALL_DIR}/src/"

INSTALLED_SIZE=$(du -sk "$PKG_DIR/usr" | cut -f1)

cat > "$PKG_DIR/DEBIAN/control" << EOF
Package: ${NAME}
Version: ${VERSION}
Section: admin
Priority: optional
Architecture: all
Depends: cockpit (>= 286)
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
