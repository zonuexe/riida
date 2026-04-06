#!/usr/bin/env sh
# Starts the riida MCP server using the Nix flake.
# This script sources the Nix profile so it works even when the calling
# process (e.g. a GUI-launched Claude Code) does not have nix in PATH.
set -e

# Source nix profile if nix is not already in PATH.
if ! command -v nix > /dev/null 2>&1; then
  NIX_PROFILE="/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh"
  if [ -f "$NIX_PROFILE" ]; then
    # shellcheck disable=SC1090
    . "$NIX_PROFILE"
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FLAKE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

exec nix --extra-experimental-features 'nix-command flakes' \
  run "${FLAKE_DIR}#riida-mcp"
