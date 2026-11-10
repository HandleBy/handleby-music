#!/bin/sh
# Builds dist/handleby-music.mcpb (the Claude desktop extension) from this repository.
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
stage="$(mktemp -d)"
mkdir -p "$stage/server" "$root/dist"
cp "$root/mcpb/manifest.json" "$stage/manifest.json"
cp "$root/server/"*.js "$stage/server/"
cp "$root/README.md" "$root/PRIVACY.md" "$root/LICENSE" "$stage/"
cp "$root/.claude-plugin/icon.png" "$stage/icon.png"
npx -y @anthropic-ai/mcpb@2.1.2 pack "$stage" "$root/dist/handleby-music.mcpb"
rm -rf "$stage"
