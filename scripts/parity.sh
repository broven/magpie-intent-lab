#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
upstream="${MAGPIE_SOURCE:-/tmp/magpie-latest}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/intent-lab-parity.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
# The reference checkout stays read-only. Only this disposable copy gets a test.
cp -R "$upstream" "$tmp/magpie"
cp "$root/scripts/parity_go_test.go.txt" "$tmp/magpie/internal/gateway/intent_lab_parity_test.go"
go_bin="${GO_BIN:-$(command -v go)}"
# Prefer an already installed current toolchain; never edit mise/global config.
if [[ "$($go_bin env GOVERSION)" == go1.2[0-5]* ]]; then
  for candidate in "$HOME"/.local/share/mise/installs/go/1.27*/bin/go; do
    if [[ -x "$candidate" ]]; then go_bin="$candidate"; fi
  done
fi
export GOPATH="$("$go_bin" env GOPATH)"
export GOMODCACHE="$("$go_bin" env GOMODCACHE)"
export GOCACHE="$("$go_bin" env GOCACHE)"
mkdir -p "$tmp/home"
INTENT_LAB_FIXTURES="$root/fixtures" INTENT_LAB_GO_OUTPUT="$tmp/go.json" \
HOME="$tmp/home" USERPROFILE="$tmp/home" XDG_CONFIG_HOME="$tmp/home/.config" \
"$go_bin" -C "$tmp/magpie" test -p 2 -tags nogui ./internal/gateway -run '^TestIntentLabParity$' -count=1 -v
bun "$root/scripts/parity.ts" "$tmp/go.json" "$tmp/ts.json"
