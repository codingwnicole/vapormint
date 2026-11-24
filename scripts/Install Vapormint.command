#!/bin/bash
# Double-click this to install Vapormint.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$SCRIPT_DIR/Vapormint.app"
if [ ! -d "$APP" ]; then echo "Could not find Vapormint.app next to this script." >&2; exit 1; fi
if [ -w /Applications ]; then DIR=/Applications; OTHER="$HOME/Applications"; else DIR="$HOME/Applications"; OTHER=/Applications; fi
mkdir -p "$DIR"
rm -rf "$OTHER/Vapormint.app" 2>/dev/null || true
rm -rf "$DIR/Vapormint.app"
cp -R "$APP" "$DIR/Vapormint.app"
xattr -cr "$DIR/Vapormint.app"
echo ""
echo "Vapormint has been installed to $DIR."
echo "You can close this window and open Vapormint from Launchpad or Spotlight."
echo ""
