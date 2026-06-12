#!/usr/bin/env bash
# Build frostd at the pinned rev and place it where Tauri expects sidecars.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
PINNED_REV="$(cat "$SCRIPT_DIR/PINNED_REV")"
FROST_TOOLS_DIR="${FROST_TOOLS_DIR:-$HOME/frost-tools}"
TARGET_TRIPLE="$(rustc -vV | sed -n 's/host: //p')"

if [ ! -d "$FROST_TOOLS_DIR" ]; then
  git clone https://github.com/ZcashFoundation/frost-tools.git "$FROST_TOOLS_DIR"
fi

cd "$FROST_TOOLS_DIR"
git fetch --quiet origin
git checkout --quiet "$PINNED_REV"

cargo build --release -p frostd

mkdir -p "$REPO_ROOT/src-tauri/binaries"
cp target/release/frostd "$REPO_ROOT/src-tauri/binaries/frostd-$TARGET_TRIPLE"
echo "sidecar ready: src-tauri/binaries/frostd-$TARGET_TRIPLE"
