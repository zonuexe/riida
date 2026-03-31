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
