#!/usr/bin/env bash
# Build script for everything-search VSIX with hphe-mcp.exe bundled.
#
# This script:
# 1. Builds hphe-mcp.exe from Rust source (if not already present)
# 2. Copies the binary to extension/server/
# 3. Packages the extension as VSIX using vsce
#
# Usage: ./package-vsix.sh [--skip-build]
#
# The bundled hphe-mcp.exe eliminates the 'spawn python ENOENT' error on
# machines without Python installed, making the extension fully standalone.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Script lives at repo root (task worktree root), so ROOT_DIR == SCRIPT_DIR
ROOT_DIR="$SCRIPT_DIR"
EXTENSION_DIR="$ROOT_DIR/extension"
HPHE_DIR="$ROOT_DIR/hphe"
BINARY_NAME="hphe-mcp.exe"

# Parse args
SKIP_BUILD=false
if [[ "${1:-}" == "--skip-build" ]]; then
  SKIP_BUILD=true
fi

echo "=========================================="
echo "  everything-search VSIX Packaging"
echo "=========================================="
echo ""

# Step 1: Build hphe-mcp.exe (release)
if [[ "$SKIP_BUILD" == "false" ]]; then
  echo "[1/3] Building hphe-mcp.exe (release)..."
  cd "$HPHE_DIR"
  if ! cargo build --release --bin hphe-mcp; then
    echo "ERROR: cargo build failed"
    exit 1
  fi
  echo "✓ Build successful"
else
  echo "[1/3] Skipping build (--skip-build flag)"
fi

# Step 2: Copy binary to extension
echo ""
echo "[2/3] Copying $BINARY_NAME to extension/server/..."
SOURCE_BIN="$HPHE_DIR/target/release/$BINARY_NAME"
DEST_BIN="$EXTENSION_DIR/server/$BINARY_NAME"

if [[ ! -f "$SOURCE_BIN" ]]; then
  echo "ERROR: $SOURCE_BIN not found. Build it first (cargo build --release --bin hphe-mcp)"
  exit 1
fi

cp -f "$SOURCE_BIN" "$DEST_BIN"
SIZE_KB=$(du -k "$DEST_BIN" | cut -f1)
echo "✓ Copied to $DEST_BIN (${SIZE_KB} KB)"

# Verify binary runs
echo ""
echo "  Verifying binary..."
if ! "$DEST_BIN" --version > /dev/null 2>&1; then
  echo "ERROR: Binary verification failed"
  exit 1
fi
echo "✓ Binary verification passed"

# Step 3: Package VSIX
echo ""
echo "[3/3] Packaging VSIX..."
cd "$EXTENSION_DIR"

# Check if vsce is available
if ! command -v vsce &> /dev/null; then
  if ! npx --no-install vsce --version &> /dev/null 2>&1; then
    echo "ERROR: vsce not found. Install it: npm install -g @vscode/vsce"
    exit 1
  fi
  VSCE="npx --no-install vsce"
else
  VSCE="vsce"
fi

# Package (private extensions skip publisher requirement)
# vsce/node needs a NATIVE Windows path — MSYS paths (/c/...) get mangled to C:\c\...
mkdir -p "$EXTENSION_DIR"
if command -v cygpath &> /dev/null; then
  OUT_DIR="$(cygpath -w "$ROOT_DIR")"
else
  OUT_DIR="$ROOT_DIR"
fi
$VSCE package --out "$OUT_DIR\\everything-search.vsix"

VSIX_PATH="$ROOT_DIR/everything-search.vsix"
if [[ -f "$VSIX_PATH" ]]; then
  VSIX_SIZE_KB=$(du -k "$VSIX_PATH" | cut -f1)
  echo ""
  echo "=========================================="
  echo "  ✓ VSIX created successfully"
  echo "=========================================="
  echo "  Location: $VSIX_PATH"
  echo "  Size:     ${VSIX_SIZE_KB} KB"
  echo ""
  echo "  Install: code --install-extension \"$VSIX_PATH\""
  echo "=========================================="
else
  echo "ERROR: VSIX packaging failed"
  exit 1
fi
