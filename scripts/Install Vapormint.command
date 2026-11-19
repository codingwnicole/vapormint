#!/bin/bash
# Double-click this to install Vapormint.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$SCRIPT_DIR/Vapormint.app"
if [ ! -d "$APP" ]; then echo "Could not find Vapormint.app next to this script." >&2; exit 1; fi
DEST="$HOME/Applications/Vapormint.app"
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
cp -R "$APP" "$DEST"
xattr -cr "$DEST"
echo ""
echo "Vapormint has been installed to ~/Applications."
echo "You can close this window and open Vapormint from Launchpad or Spotlight."
echo ""
