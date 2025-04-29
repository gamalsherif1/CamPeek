#!/bin/bash

EXTENSION_UUID="CamPeek@gemo.info"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/$EXTENSION_UUID"

echo "📦 Installing $EXTENSION_UUID..."

# Check if source folder exists
if [ ! -d "$SOURCE" ]; then
  echo "❌ Error: Extension folder '$EXTENSION_UUID' not found in this directory."
  exit 1
fi

# Create extensions directory if needed
mkdir -p "$EXTENSION_DIR"

# Remove existing copy
if [ -e "$EXTENSION_DIR/$EXTENSION_UUID" ]; then
  echo "🔄 Removing existing extension..."
  rm -rf "$EXTENSION_DIR/$EXTENSION_UUID"
fi

# Link the extension into the GNOME extensions directory
ln -s "$SOURCE" "$EXTENSION_DIR/$EXTENSION_UUID"
echo "✅ Extension installed at $EXTENSION_DIR/$EXTENSION_UUID"

# Enable the extension
gnome-extensions enable "$EXTENSION_UUID" || echo "⚠️ Extension not enabled automatically. You can enable it from the Extensions app."

# Optional: restart GNOME Shell (only works on X11)
read -p "🔃 Restart GNOME Shell now (Alt+F2 > r)? [y/N] " answer
if [[ "$answer" == "y" || "$answer" == "Y" ]]; then
  gnome-shell --replace &
fi
