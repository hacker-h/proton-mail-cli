#!/bin/sh
set -eu

REPO="${REPO:-hacker-h/proton-mail-cli}"
TAG="${TAG:-${VERSION:-latest}}"
PREFIX="${PREFIX:-$HOME/.local}"
API_BASE="${PROTON_MAIL_CLI_INSTALL_API_BASE:-https://api.github.com/repos}"

die() {
  printf '%s\n' "proton-mail-cli installer: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

need curl
need node
need npm

case "$TAG" in
  latest|v*|[0-9]*) ;;
  *) die "unsupported TAG/VERSION '$TAG'; use 'latest', 'vX.Y.Z', or 'X.Y.Z'" ;;
esac

case "$TAG" in
  latest) release_url="$API_BASE/$REPO/releases/latest" ;;
  v*) release_url="$API_BASE/$REPO/releases/tags/$TAG" ;;
  *) release_url="$API_BASE/$REPO/releases/tags/v$TAG" ;;
esac

tmp_dir="$(mktemp -d 2>/dev/null || mktemp -d -t proton-mail-cli-install)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT INT TERM

release_json="$tmp_dir/release.json"
curl -fsSL "$release_url" -o "$release_json" || die "failed to fetch release metadata from $release_url"

node - "$release_json" > "$tmp_dir/assets.env" <<'NODE'
const fs = require('node:fs');
const releasePath = process.argv[2];
const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
const assets = Array.isArray(release.assets) ? release.assets : [];
const tarballs = assets.filter((asset) => /^proton-mail-cli-.+\.tgz$/.test(asset.name || ''));
const checksums = assets.filter((asset) => asset.name === 'SHA256SUMS');
if (tarballs.length !== 1) {
  console.error(`expected exactly one proton-mail-cli-*.tgz asset, found ${tarballs.length}`);
  process.exit(2);
}
if (checksums.length !== 1) {
  console.error(`expected exactly one SHA256SUMS asset, found ${checksums.length}`);
  process.exit(3);
}
for (const [key, asset] of [['TARBALL', tarballs[0]], ['CHECKSUMS', checksums[0]]]) {
  if (!asset.browser_download_url) {
    console.error(`${asset.name} has no browser_download_url`);
    process.exit(4);
  }
  console.log(`${key}_NAME=${JSON.stringify(asset.name)}`);
  console.log(`${key}_URL=${JSON.stringify(asset.browser_download_url)}`);
}
NODE

. "$tmp_dir/assets.env" || die "release metadata does not contain supported assets"

tarball="$tmp_dir/$TARBALL_NAME"
checksums="$tmp_dir/SHA256SUMS"
curl -fsSL "$TARBALL_URL" -o "$tarball" || die "failed to download $TARBALL_NAME"
curl -fsSL "$CHECKSUMS_URL" -o "$checksums" || die "failed to download SHA256SUMS"

node - "$checksums" "$tarball" "$TARBALL_NAME" <<'NODE' || die "checksum verification failed for $TARBALL_NAME"
const crypto = require('node:crypto');
const fs = require('node:fs');
const [checksumsPath, tarballPath, tarballName] = process.argv.slice(2);
const entries = fs.readFileSync(checksumsPath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line);
    if (!match) throw new Error(`invalid SHA256SUMS line: ${line}`);
    return { hash: match[1].toLowerCase(), file: match[2] };
  });
const expected = entries.find((entry) => entry.file === tarballName);
if (!expected) throw new Error(`SHA256SUMS does not contain ${tarballName}`);
const actual = crypto.createHash('sha256').update(fs.readFileSync(tarballPath)).digest('hex');
if (actual !== expected.hash) throw new Error(`expected ${expected.hash}, got ${actual}`);
NODE

mkdir -p "$PREFIX"
npm install --global --prefix "$PREFIX" --no-audit --no-fund "$tarball" >/dev/null || die "npm install failed"

pm_bin="$PREFIX/bin/pm"
[ -x "$pm_bin" ] || die "installed pm binary is missing at $pm_bin"
"$pm_bin" --help >/dev/null || die "installed pm --help failed"

printf 'Installed pm to %s\n' "$pm_bin"
printf 'Add %s/bin to PATH if needed.\n' "$PREFIX"
