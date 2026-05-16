# Releasing

Releases are automated by semantic-release on pushes to `main` through `.github/workflows/release.yml`.

## Release Inputs

semantic-release reads Conventional Commits from git history and publishes a GitHub Release when a releasable commit is present:

- `fix:` creates a patch release.
- `feat:` creates a minor release.
- breaking changes create a major release.

The release job runs `pnpm ci:offline` before publishing, so release eligibility matches the deterministic pull-request gate.

## Changelog

GitHub Release notes are the release changelog source of truth. The release workflow does not push generated changelog or version commits back to `main`, because `main` is protected and all repository changes must go through pull requests.

## First Release Baseline

This repository currently has no release tags. The first semantic-release run on `main` will calculate its release from the existing Conventional Commit history. If maintainers need to preserve the current `package.json` version line as the first baseline, create the intended baseline tag before merging release automation.

## Package Artifact

`package.json` is currently marked `private`, so releases do not publish to the npm registry. The release workflow instead runs `@semantic-release/npm` with `npmPublish: false`, creates a packed `.tgz` artifact, and attaches that tarball to the GitHub Release.

semantic-release updates `package.json` only in the release job workspace before packing. The repository `package.json` intentionally keeps a `0.0.0` baseline for local and git-URL checkouts; the git tag, GitHub Release, tarball filename, and tarball metadata are the source of truth for the published artifact version.

## Release Asset Smoke

`.github/workflows/release-asset-smoke.yml` verifies the uploaded GitHub Release tarball and `SHA256SUMS`, not a local workspace pack. It runs automatically when a release is published and can also be run manually from GitHub Actions with an explicit tag or with the latest release.

Manual local equivalent:

```bash
GH_TOKEN="$(gh auth token)" pnpm release:asset-smoke -- --tag v2.0.0
```

Omit `--tag` to verify the latest GitHub Release. The smoke downloads `proton-mail-cli-*.tgz` from GitHub Releases, installs it into a clean temporary app, checks `node_modules/.bin/pm --help`, `pm --version`, a JSON failure envelope, and package exports. It does not use Proton credentials and does not run live Proton tests.

Releases publish a `SHA256SUMS` asset alongside the package tarball. The release asset smoke verifies that file before installing the tarball. Older releases that predate `SHA256SUMS` can be checked with `pnpm release:asset-smoke -- --tag <tag> --allow-missing-checksums`, but installer and update flows must not use that legacy bypass: they must fail before installing or executing downloaded content if `SHA256SUMS` is missing, if the tarball is not listed, or if the SHA-256 digest does not match.

## Installer

`install.sh` is the one-line GitHub Release installer documented in `README.md`. It requires Node.js, npm, curl, and POSIX `sh`; defaults to the latest release; accepts `TAG=vX.Y.Z` or `VERSION=X.Y.Z`; installs with `npm install --global --prefix "${PREFIX:-$HOME/.local}"`; verifies `SHA256SUMS` before installation; and runs `pm --help` before reporting success. It must not read Proton credentials, config files, or saved sessions.

If this package should be published to npm later:

1. Remove `"private": true` from `package.json`.
2. Add the intended npm package metadata and `publishConfig`.
3. Configure npm trusted publishing for `.github/workflows/release.yml`, or add an `NPM_TOKEN` fallback.
4. Change `release.config.mjs` to publish with `@semantic-release/npm`.

## Secrets And Permissions

Current GitHub-only releases require no repository secrets. The workflow uses the built-in `GITHUB_TOKEN` with `contents: write`, `issues: write`, and `pull-requests: write` so semantic-release can create tags/releases and comment on released issues or pull requests. It must not bypass branch protection or push commits directly to `main`.

Live Proton regression secrets are intentionally separate from release automation. Do not make `pnpm test:live` a release prerequisite; Proton-side drift should not block deterministic package releases.
