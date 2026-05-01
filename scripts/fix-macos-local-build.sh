#!/usr/bin/env bash

set -euo pipefail

APP_PATH="${1:-src-tauri/target/release/bundle/macos/riida.app}"
BIN_PATH="$APP_PATH/Contents/MacOS/riida"
SYSTEM_ICONV="/usr/lib/libiconv.2.dylib"

if [[ ! -e "$BIN_PATH" ]]; then
  echo "Binary not found: $BIN_PATH" >&2
  exit 1
fi

ICONV_PATH="$(otool -L "$BIN_PATH" | awk '/libiconv\.2\.dylib/ { print $1; exit }')"

if [[ -n "${ICONV_PATH:-}" && "$ICONV_PATH" != "$SYSTEM_ICONV" ]]; then
  install_name_tool -change "$ICONV_PATH" "$SYSTEM_ICONV" "$BIN_PATH"
fi

codesign --force --deep --sign - "$APP_PATH"
xattr -cr "$APP_PATH"

echo "Patched and re-signed $APP_PATH"

# The DMG that `tauri build` produced still embeds the un-patched .app.
# Regenerate it from the patched .app so mounting and running from the
# DMG no longer crashes with a libiconv code-signature mismatch.
DMG_DIR="$(dirname "$(dirname "$APP_PATH")")/dmg"
if [[ -d "$DMG_DIR" ]]; then
  EXISTING_DMG="$(find "$DMG_DIR" -maxdepth 1 -name '*.dmg' -print -quit || true)"
  if [[ -n "${EXISTING_DMG:-}" ]]; then
    DMG_NAME="$(basename "$EXISTING_DMG")"
    APP_NAME="$(basename "$APP_PATH" .app)"
    rm -f "$EXISTING_DMG"
    hdiutil create \
      -volname "$APP_NAME" \
      -srcfolder "$APP_PATH" \
      -ov \
      -format UDZO \
      "$DMG_DIR/$DMG_NAME" >/dev/null
    echo "Rebuilt $DMG_DIR/$DMG_NAME from patched .app"
  fi
fi
