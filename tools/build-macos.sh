#!/bin/bash
# Native macOS packager; no npm install, builder, or publishing.
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: bash tools/build-macos.sh [--arch arm64|x64] [--node-version 24.x.y] [--dmg]' \
    'Requires macOS and local Node 24. Downloads verified official Electron/Node archives.' \
    'Output: dist/macos-<version>-<arch>-<unique>/Notidea.app.zip (and optional Notidea.dmg).' \
    'Ad-hoc signing only: NOT Developer ID signed or notarized.'
}
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
arch=''
node_version=''
make_dmg=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --arch) [ "$#" -ge 2 ] || fail '--arch requires a value'; arch="$2"; shift 2 ;;
    --node-version) [ "$#" -ge 2 ] || fail '--node-version requires a value'; node_version="$2"; shift 2 ;;
    --dmg) make_dmg=1; shift ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
case "$arch" in ''|arm64|x64) ;; *) fail 'Architecture must be arm64 or x64' ;; esac
[ "$(uname -s)" = Darwin ] || fail 'Build on macOS; cross-packaging from Windows/Linux is not supported'
if [ -z "$arch" ]; then
  case "$(uname -m)" in arm64) arch=arm64 ;; x86_64) arch=x64 ;; *) fail 'Unsupported host architecture' ;; esac
fi
for tool in node curl shasum ditto tar sips iconutil codesign lipo mktemp; do
  command -v "$tool" >/dev/null 2>&1 || fail "Missing required tool: $tool"
done
[ -x /usr/libexec/PlistBuddy ] || fail 'Missing /usr/libexec/PlistBuddy'
if [ "$make_dmg" = 1 ]; then command -v hdiutil >/dev/null 2>&1 || fail 'Missing hdiutil'; fi
[ "$(node -p 'process.versions.node.split(".")[0]')" = 24 ] || fail 'Local Node 24 is required to read metadata'
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ -z "$node_version" ]; then node_version="$(node -p 'process.versions.node')"; fi
[[ "$node_version" =~ ^24\.[0-9]+\.[0-9]+$ ]] || fail 'Node version must be an exact 24.x.y release (without v)'
version="$(node -e 'const p=require(process.argv[1]); const v=require(process.argv[2]).version; if(p.version!==v) throw Error("package.json/version.js mismatch"); if(!/^\d+\.\d+\.\d+$/.test(v)) throw Error("Expected numeric x.y.z app version"); if(p.main!=="electron/main.js") throw Error("Unexpected package main"); console.log(v)' "$root/package.json" "$root/version.js")"
electron_version="$(node -e 'const v=require(process.argv[1]).devDependencies.electron; if(!/^\d+\.\d+\.\d+$/.test(v)) throw Error("Electron must be pinned to an exact version"); console.log(v)' "$root/package.json")"
sources=(lib electron public assets prompts server.js db.js llm.js version.js package.json README.md LICENSE)
# Refuse symlinks/special files in source payload, preventing accidental external data inclusion.
node -e 'const fs=require("node:fs"),path=require("node:path"); function check(p){const s=fs.lstatSync(p); if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile())) throw Error("Unsupported source: "+p); if(s.isDirectory()) for(const n of fs.readdirSync(p)) check(path.join(p,n));} for(const n of process.argv.slice(2)) check(path.join(process.argv[1],n));' "$root" "${sources[@]}"
[ -f "$root/assets/icon.png" ] || fail 'Missing assets/icon.png'
# Only this newly created private staging directory is ever recursively deleted.
work="$(mktemp -d /private/tmp/notidea-macos.XXXXXXXX)"
cleanup() {
  case "$work" in /private/tmp/notidea-macos.????????) [ ! -L "$work" ] && rm -rf -- "$work" ;; esac
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$work/downloads" "$work/electron" "$work/node" "$work/Notidea.iconset" "$work/image"
fetch() { curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --output "$2" "$1"; }
verify() {
  # Exact filename matching, one manifest entry only; verify with the system SHA256 implementation.
  local expected actual
  expected="$(node -e 'const fs=require("node:fs"); const rows=fs.readFileSync(process.argv[1],"utf8").split(/\r?\n/).map(s=>s.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)).filter(m=>m&&m[2]===process.argv[2]); if(rows.length!==1) throw Error("Missing/duplicate checksum entry"); console.log(rows[0][1].toLowerCase())' "$1" "$2")"
  actual="$(shasum -a 256 "$work/downloads/$2")"
  [ "${actual%% *}" = "$expected" ] || fail "SHA256 mismatch: $2"
}
electron_zip="electron-v${electron_version}-darwin-${arch}.zip"
node_tar="node-v${node_version}-darwin-${arch}.tar.gz"
printf 'Packaging Notidea %s; Electron %s; Node %s; %s\n' "$version" "$electron_version" "$node_version" "$arch"
fetch "https://github.com/electron/electron/releases/download/v${electron_version}/SHASUMS256.txt" "$work/downloads/electron-SHASUMS256.txt"
fetch "https://github.com/electron/electron/releases/download/v${electron_version}/$electron_zip" "$work/downloads/$electron_zip"
verify "$work/downloads/electron-SHASUMS256.txt" "$electron_zip"
fetch "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" "$work/downloads/node-SHASUMS256.txt"
fetch "https://nodejs.org/dist/v${node_version}/$node_tar" "$work/downloads/$node_tar"
verify "$work/downloads/node-SHASUMS256.txt" "$node_tar"
ditto -x -k "$work/downloads/$electron_zip" "$work/electron"
tar -xzf "$work/downloads/$node_tar" -C "$work/node"
app="$work/image/Notidea.app"
ditto "$work/electron/Electron.app" "$app"
resources="$app/Contents/Resources"
payload="$resources/app"
mkdir -p "$payload/runtime"
for item in "${sources[@]}"; do ditto "$root/$item" "$payload/$item"; done
node_home="$work/node/node-v${node_version}-darwin-${arch}"
ditto "$node_home/bin/node" "$payload/runtime/node"
ditto "$node_home/LICENSE" "$payload/runtime/LICENSE.node"
# Keep Electron's license notices alongside the application's own license.
for notice in LICENSE LICENSES.chromium.html; do
  if [ -f "$work/electron/$notice" ]; then ditto "$work/electron/$notice" "$resources/$notice.electron"; fi
done
chmod 755 "$payload/runtime/node"
mach_arch="$arch"; [ "$arch" != x64 ] || mach_arch=x86_64
lipo "$payload/runtime/node" -verify_arch "$mach_arch"
lipo "$app/Contents/MacOS/Electron" -verify_arch "$mach_arch"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$root/assets/icon.png" --out "$work/Notidea.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$root/assets/icon.png" --out "$work/Notidea.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$work/Notidea.iconset" -o "$resources/Notidea.icns"
plist="$app/Contents/Info.plist"
set_plist() {
  /usr/libexec/PlistBuddy -c "Set :$1 $2" "$plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$plist"
}
set_plist CFBundleName Notidea
set_plist CFBundleDisplayName Notidea
set_plist CFBundleIdentifier app.notidea.desktop
set_plist CFBundleShortVersionString "$version"
set_plist CFBundleVersion "$version"
set_plist CFBundleIconFile Notidea.icns
# Preserve Electron's existing JIT entitlements when replacing its upstream signature.
codesign --force --sign - "$payload/runtime/node"
codesign --force --deep --sign - --preserve-metadata=entitlements "$app"
codesign --verify --deep --strict --verbose=2 "$app"
ditto -c -k --sequesterRsrc --keepParent "$app" "$work/Notidea.app.zip"
if [ "$make_dmg" = 1 ]; then
  ln -s /Applications "$work/image/Applications"
  hdiutil create -volname Notidea -srcfolder "$work/image" -ov -format UDZO "$work/Notidea.dmg"
  hdiutil verify "$work/Notidea.dmg"
fi
# Unique output directory; never overwrite or delete an existing user output.
mkdir -p "$root/dist"
out="$(mktemp -d "$root/dist/macos-${version}-${arch}-XXXXXXXX")"
ditto "$work/Notidea.app.zip" "$out/Notidea.app.zip"
if [ "$make_dmg" = 1 ]; then ditto "$work/Notidea.dmg" "$out/Notidea.dmg"; fi
printf 'Output: %s\nAd-hoc signed only; NOT Developer ID signed or notarized. Gatekeeper may block distribution.\n' "$out"
