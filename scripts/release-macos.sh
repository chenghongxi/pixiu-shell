#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS release packaging must run on macOS." >&2
  exit 1
fi

PRODUCT="$(node -p 'require("./src-tauri/tauri.conf.json").productName')"
VERSION="$(node -p 'require("./package.json").version')"
EXPECTED_BUNDLE_ID="com.chenlian.tshell"
CONFIGURED_BUNDLE_ID="$(node -p 'require("./src-tauri/tauri.conf.json").identifier')"
IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Hangzhou Chenlian Information Technology Co., Ltd (GC679455P9)}"
TEAM_ID="${APPLE_SIGNING_TEAM_ID:-GC679455P9}"
PROFILE="${APPLE_NOTARY_PROFILE:-TSHELL_NOTARY}"
BUNDLE_DIR="$ROOT/src-tauri/target/release/bundle/macos"
APP="$BUNDLE_DIR/$PRODUCT.app"
CANDIDATE="$BUNDLE_DIR/$PRODUCT-$VERSION-macos-signed-notarization-pending.zip"
RELEASE="$BUNDLE_DIR/$PRODUCT-$VERSION-macos.zip"

if [[ "$CONFIGURED_BUNDLE_ID" != "$EXPECTED_BUNDLE_ID" ]]; then
  echo "Refusing to package bundle identifier '$CONFIGURED_BUNDLE_ID'; expected '$EXPECTED_BUNDLE_ID'." >&2
  exit 1
fi

if ! security find-identity -v -p codesigning | grep -Fq "$IDENTITY"; then
  echo "Developer ID signing identity is unavailable: $IDENTITY" >&2
  exit 1
fi

verify_signed_app() {
  if [[ ! -d "$APP" ]]; then
    echo "Expected app bundle was not created: $APP" >&2
    exit 1
  fi

  codesign --verify --deep --strict --verbose=2 "$APP"
  local signature
  signature="$(codesign -dv --verbose=4 "$APP" 2>&1)"
  printf '%s\n' "$signature"
  if ! grep -Fq "Authority=$IDENTITY" <<<"$signature" || ! grep -Fq "TeamIdentifier=$TEAM_ID" <<<"$signature"; then
    echo "App bundle is not signed by the expected Developer ID team." >&2
    exit 1
  fi
  if ! grep -Fq "Identifier=$EXPECTED_BUNDLE_ID" <<<"$signature"; then
    echo "App bundle has the wrong bundle identifier." >&2
    exit 1
  fi
}

if [[ "${1:-}" == "--notarize" ]]; then
  if [[ ! -f "$CANDIDATE" ]]; then
    echo "Signed candidate is missing; first run npm run release:macos." >&2
    exit 1
  fi
  if [[ -e "$RELEASE" ]]; then
    echo "Notarized archive already exists; preserve it and bump the package version before rebuilding." >&2
    exit 1
  fi
  verify_signed_app
  if ! xcrun notarytool history --keychain-profile "$PROFILE" --output-format json >/dev/null; then
    echo "Apple notarization credentials are unavailable for keychain profile '$PROFILE'." >&2
    exit 1
  fi
  xcrun notarytool submit "$CANDIDATE" --keychain-profile "$PROFILE" --wait --output-format json
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl --assess --type execute --verbose=4 "$APP"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$RELEASE"
  echo "Notarized release: $RELEASE"
  exit 0
fi

if [[ -e "$CANDIDATE" || -e "$RELEASE" ]]; then
  echo "A release archive already exists for version $VERSION; preserve it and bump the package version before rebuilding." >&2
  exit 1
fi

APPLE_SIGNING_IDENTITY="$IDENTITY" npm run tauri -- build --bundles app
verify_signed_app

ditto -c -k --sequesterRsrc --keepParent "$APP" "$CANDIDATE"
echo "Signed candidate: $CANDIDATE"
echo "Notarization was not requested. This candidate is not ready to distribute to other Macs."
