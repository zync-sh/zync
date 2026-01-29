#!/bin/bash

# Local Install Script for Zync
# Installs the locally built AppImage from release/ folder

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

APP_NAME="Zync"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/zync"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"

# Uninstall Logic
if [[ "$1" == "--uninstall" ]]; then
    echo -e "${BLUE}Uninstalling Zync...${NC}"
    
    echo "Removing symlink..."
    rm -f "$BIN_DIR/zync"
    
    echo "Removing app directory..."
    rm -rf "$APP_DIR"
    
    echo "Removing desktop entry..."
    rm -f "$DESKTOP_DIR/$APP_NAME.desktop"
    rm -f "$DESKTOP_DIR/zync.desktop"
    
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$DESKTOP_DIR"
    fi
    
    echo -e "${GREEN}✔ Uninstalled Zync locally!${NC}"
    exit 0
fi

# Cleanup old desktop entries before install
rm -f "$DESKTOP_DIR/Zync.desktop"

# 1. Get Version from package.json
if [ ! -f "package.json" ]; then
    echo -e "${RED}Error: package.json not found. Run this from the app root.${NC}"
    exit 1
fi

VERSION=$(grep -m1 '"version":' package.json | cut -d '"' -f 4)
echo -e "${BLUE}Detected Version: $VERSION${NC}"

# 2. Find AppImage in release folder
RELEASE_DIR="release/$VERSION"
APPIMAGE=$(find "$RELEASE_DIR" -name "*.AppImage" | head -n 1)

if [ -z "$APPIMAGE" ]; then
    echo -e "${RED}Error: No AppImage found in $RELEASE_DIR${NC}"
    echo "Did you run 'npm run build:linux'?"
    exit 1
fi

echo -e "Found AppImage: $APPIMAGE"

# 3. Install
echo -e "${BLUE}Installing locally...${NC}"

mkdir -p "$BIN_DIR"
mkdir -p "$DESKTOP_DIR"
mkdir -p "$APP_DIR"

# Copy AppImage
cp "$APPIMAGE" "$APP_DIR/Zync.AppImage"
chmod +x "$APP_DIR/Zync.AppImage"

# Symlink
ln -sf "$APP_DIR/Zync.AppImage" "$BIN_DIR/zync"

# Copy Icon to system icon theme
mkdir -p "$ICON_DIR"
if [ -f "build/icon.png" ]; then
    cp "build/icon.png" "$ICON_DIR/zync.png"
elif [ -f "public/icon.png" ]; then
    cp "public/icon.png" "$ICON_DIR/zync.png"
fi

# 4. Desktop Entry
cat > "$DESKTOP_DIR/zync.desktop" <<EOF
[Desktop Entry]
Name=Zync
Exec=$APP_DIR/Zync.AppImage --no-sandbox %U
Icon=zync
Type=Application
Categories=Development;Utility;
Terminal=false
StartupWMClass=zync
EOF

# Update desktop db
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR"
fi

# Update icon cache
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor"
fi

echo -e "${GREEN}✔ Installed Zync (v$VERSION) locally!${NC}"
echo -e "   Run with: zync"
