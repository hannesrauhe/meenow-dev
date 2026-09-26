#!/usr/bin/env bash
# meenow installer — run ON the hosting server, inside an instance directory.
# Downloads a prepared build from GitHub and installs it in place; nothing on
# this machine needs Node, and server-owned files (config/, cache/, vendor/,
# .install.conf) are never touched.
#
# Usage (from inside the instance dir):
#   ./install.sh                 latest stable release
#   ./install.sh v1.2.3          a specific release
#   ./install.sh --pr 42         preview build of PR #42
#   ./install.sh --ref main      preview build of main
#   ./install.sh --rollback      re-install the previously installed build
#
# First-time bootstrap (instance dir empty):
#   curl -fSLO https://github.com/OWNER/REPO/releases/latest/download/install.sh
#   echo 'REPO=OWNER/REPO' > .install.conf
#   bash install.sh
#
# .install.conf (this dir, server-owned): REPO=owner/name; optional
# GITHUB_TOKEN for private repos (exported, not stored, if you prefer).
set -euo pipefail
cd "$(dirname "$0")"
DIR=$PWD
CONF=$DIR/.install.conf
RELEASES=$DIR/.releases

[ -f "$CONF" ] || { echo "missing .install.conf (REPO=owner/name) — see server/README.md" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
[ -n "${REPO:-}" ] || { echo ".install.conf must define REPO=owner/name" >&2; exit 1; }

# --- args ----------------------------------------------------------------------
ASSET=""
ROLLBACK=0
case "${1:-}" in
  --rollback) ROLLBACK=1 ;;
  --pr)       ASSET="meenow-preview-pr-$2.tar.gz" ;;
  --ref)      ASSET="meenow-preview-${2}.tar.gz" ;;
  "")         : ;;  # latest stable, resolved below
  v*)         ASSET="meenow-$1.tar.gz" ;;
  *)          echo "unknown argument: $1" >&2; exit 1 ;;
esac

# --- helpers -------------------------------------------------------------------
gh_curl() {  # curl with optional auth (private repos); public repos need none
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$@"
  else
    curl -fsSL "$@"
  fi
}
api() { gh_curl -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/$1"; }

mkdir -p "$RELEASES"

if [ "$ROLLBACK" = 1 ]; then
  PREV=$(cat "$RELEASES/PREVIOUS" 2>/dev/null || true)
  [ -n "$PREV" ] && [ -f "$RELEASES/$PREV" ] || { echo "nothing to roll back to" >&2; exit 1; }
  ASSET="$PREV"
  echo "Rolling back to $ASSET"
else
  if [ -z "$ASSET" ]; then
    TAG=$(api "releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
    [ -n "$TAG" ] || { echo "could not resolve latest release" >&2; exit 1; }
    ASSET="meenow-$TAG.tar.gz"
  fi
  case "$ASSET" in
    meenow-preview-*) REL=preview ;;
    *)                REL="${ASSET#meenow-}"; REL="${REL%.tar.gz}" ;;
  esac
  echo "Downloading $ASSET ..."
  gh_curl -o "$RELEASES/$ASSET.tmp" \
    "https://github.com/$REPO/releases/download/$REL/$ASSET"
  mv "$RELEASES/$ASSET.tmp" "$RELEASES/$ASSET"
fi

# --- install -------------------------------------------------------------------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$RELEASES/$ASSET" -C "$TMP"

OLD_VERSION=$(cat VERSION 2>/dev/null || echo "(uninstalled)")

# Merge into the instance dir; server-owned paths survive --delete.
rsync -a --delete \
  --exclude config/ --exclude cache/ --exclude vendor/ \
  --exclude .install.conf --exclude .releases/ \
  "$TMP/" "$DIR/"

# PHP dependencies are built on this machine (keeps the download small).
composer install --no-dev --optimize-autoloader --working-dir="$DIR" --no-interaction

NEW_VERSION=$(cat "$TMP/VERSION")
echo "$NEW_VERSION" > VERSION

# Record for --rollback.
if [ "$ROLLBACK" = 0 ]; then
  CUR=$(cat "$RELEASES/CURRENT" 2>/dev/null || true)
  [ -n "$CUR" ] && [ "$CUR" != "$ASSET" ] && echo "$CUR" > "$RELEASES/PREVIOUS"
  echo "$ASSET" > "$RELEASES/CURRENT"
  # Keep the three most recent tarballs.
  ls -1t "$RELEASES" | { grep '\.tar\.gz$' || true; } | tail -n +4 | while read -r f; do rm -f "$RELEASES/$f"; done
fi

# --- gate ------------------------------------------------------------------------
if [ -f config/config.php ]; then
  php scripts/smoke.php
else
  echo "Installed $NEW_VERSION — but config/config.php is missing."
  echo "Next: cp config.example.php config/config.php, fill it in, run"
  echo "      php scripts/gen-vapid.php && php scripts/smoke.php, then load schema.sql."
fi

echo "Done: $OLD_VERSION -> $NEW_VERSION"
