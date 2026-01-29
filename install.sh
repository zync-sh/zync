#!/bin/bash

# Zync Install Script
# Usage: curl -f https://raw.githubusercontent.com/FDgajju/zync-website/main/public/install.sh | sh

set -e

REPO="FDgajju/zync"
APP_NAME="Zync"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/zync"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}⚡ Installing ${APP_NAME} (AppImage)...${NC}"

# 1. Detect Architecture
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
    echo "   Detected Architecture: x64"
elif [ "$ARCH" = "aarch64" ]; then
    echo "ARM64 builds are coming soon!"
    exit 1
else
    echo "Unsupported architecture: $ARCH"
    exit 1
fi

# 2. Find Latest AppImage Release from GitHub Releases
echo "   Fetching latest release from GitHub..."
# Look for line containing browser_download_url and .AppImage
LATEST_URL=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | grep "browser_download_url.*\.AppImage\"" | cut -d '"' -f 4 | head -n 1)

if [ -z "$LATEST_URL" ]; then
    echo "   Error: Could not find .AppImage in latest release"
    echo "   Please ensure a GitHub Release exists with an AppImage asset."
    exit 1
fi

echo "   Downloading from: $LATEST_URL"

# 3. Prepare Directories
mkdir -p "$BIN_DIR"
mkdir -p "$DESKTOP_DIR"
mkdir -p "$APP_DIR"
mkdir -p "$ICON_DIR"

# 4. Download AppImage
APPIMAGE_PATH="$APP_DIR/Zync.AppImage"
curl -L "$LATEST_URL" -o "$APPIMAGE_PATH"

# 5. Make Executable
chmod +x "$APPIMAGE_PATH"
echo "   Made executable: $APPIMAGE_PATH"

# 6. Create Symlink
ln -sf "$APPIMAGE_PATH" "$BIN_DIR/zync"

# 7. Download Icon to System Theme
# Using main/public/icon.png to be safe (assumes zync repo structure)
ICON_URL="https://raw.githubusercontent.com/FDgajju/zync/main/public/icon.png"
curl -s -L "$ICON_URL" -o "$ICON_DIR/zync.png" || echo "   Warning: Could not fetch icon."

# 8. Create Desktop Entry
# Remove old/conflicting entries
rm -f "$DESKTOP_DIR/Zync.desktop"

cat > "$DESKTOP_DIR/zync.desktop" <<EOF
[Desktop Entry]
Name=$APP_NAME
Exec=$APPIMAGE_PATH --no-sandbox %U
Icon=zync
Type=Application
Categories=Development;Utility;
Terminal=false
StartupWMClass=zync
EOF

# 9. Integrate with System
# Update desktop database
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR"
fi

# Update icon cache (Crucial for Icon=zync to work)
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor"
fi

echo -e "${GREEN}✔ Successfully installed $APP_NAME${NC}"
echo -e "   Location: $APPIMAGE_PATH"
echo -e "   Symlink:  $BIN_DIR/zync"
echo -e "   You can now run: ${GREEN}zync${NC}"
