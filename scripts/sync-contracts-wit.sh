#!/usr/bin/env bash
# Sync packages/astrid-sdk/wit-contracts/astrid-contracts.wit from the
# canonical astrid-runtime/wit submodule (at contracts/interfaces/*.wit).
#
# Mirror of sdk-rust/scripts/sync-contracts-wit.sh — same canonical
# source, same single-package bundled output shape. Generating the same
# bundled file in both SDKs guarantees the Rust and JS contracts modules
# expose identical types and field names. The codegen pipelines
# (`wit_events!` in sdk-rust, `codegenWitEvents` in sdk-js) both consume
# the bundled single-package layout.
#
# Why this exists, in two parts:
#
#   1. astrid-sdk is published to npm. The package manifest only
#      includes files in `packages/astrid-sdk/`, so the WIT input to
#      `scripts/generate-contracts.mjs` has to physically live at
#      `packages/astrid-sdk/wit-contracts/astrid-contracts.wit`.
#
#   2. `codegenWitEvents` today expects ONE wit file declaring ONE
#      package containing all the interfaces. The canonical repo is
#      laid out with one package per file (astrid:context, astrid:llm,
#      …). This script transforms the per-package canonical layout
#      into the single-package bundled form:
#
#        - strips the leading `package astrid:<name>@x.y.z;` from each
#          file (replaced by a single `package astrid:contracts@1.0.0;`
#          header)
#        - rewrites `use astrid:<pkg>/<iface>.{…};` into
#          `use <iface>.{…};` — after concat all interfaces live in
#          the same package, so cross-package refs become cross-
#          interface refs in scope
#
# The bundled file is a derived artifact; canonical
# contracts/interfaces/*.wit is the source of truth. Run
# `sync-contracts-wit.sh --check` to verify the bundled file has not
# been hand-edited out of sync.
#
# Usage: scripts/sync-contracts-wit.sh
# Verify (no write):   scripts/sync-contracts-wit.sh --check

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT/contracts/interfaces"
DST="$ROOT/packages/astrid-sdk/wit-contracts/astrid-contracts.wit"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "sync-contracts-wit: source dir not found: $SRC_DIR" >&2
  echo "sync-contracts-wit: did you forget 'git submodule update --init'?" >&2
  exit 1
fi

# types must come first (foundational, referenced by others), then
# alphabetical for diff stability.
declare -a ordered
ordered+=("$SRC_DIR/types.wit")
while IFS= read -r f; do
  ordered+=("$f")
done < <(find "$SRC_DIR" -name '*.wit' ! -name 'types.wit' | sort)

generate() {
  cat <<'HEADER'
// AUTO-GENERATED — DO NOT EDIT.
//
// Concatenated from contracts/interfaces/*.wit by
// scripts/sync-contracts-wit.sh.
//
// Source of truth: astrid-runtime/wit (git submodule at contracts/).
// Run `scripts/sync-contracts-wit.sh` after pulling the submodule to
// regenerate this file.

package astrid:contracts@1.0.0;

HEADER

  for src in "${ordered[@]}"; do
    name=$(basename "$src" .wit)
    echo "// ── $name ──────────────────────────────────────────────────────────"
    sed -E \
      -e '/^[[:space:]]*package[[:space:]]+astrid:/d' \
      -e 's|^([[:space:]]*)use[[:space:]]+astrid:[^/]+/([^.]+)\.|\1use \2.|' \
      "$src"
    echo
  done
}

if [[ "${1:-}" == "--check" ]]; then
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT
  generate > "$tmp"
  if ! diff -q "$tmp" "$DST" >/dev/null 2>&1; then
    echo "sync-contracts-wit: $DST is out of sync with $SRC_DIR" >&2
    echo "sync-contracts-wit: run scripts/sync-contracts-wit.sh to fix" >&2
    diff "$tmp" "$DST" >&2 || true
    exit 1
  fi
  echo "sync-contracts-wit: in sync"
  exit 0
fi

generate > "$DST"
echo "sync-contracts-wit: $DST ← $SRC_DIR/*.wit ($(ls "$SRC_DIR" | wc -l | tr -d ' ') files)"
