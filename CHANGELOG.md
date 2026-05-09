## [1.2.1](https://github.com/hacker-h/proton-mail-cli/compare/v1.2.0...v1.2.1) (2026-05-09)


### Bug Fixes

* **http:** harden requestRaw retry and errors ([569b9bb](https://github.com/hacker-h/proton-mail-cli/commit/569b9bbadf18e0f4d27367217198c5866253b3a9))
* **http:** repair requestRaw checkjs types ([7aa6cb0](https://github.com/hacker-h/proton-mail-cli/commit/7aa6cb00e315ac3718c37e152126b77dce73b2c4)), closes [#45](https://github.com/hacker-h/proton-mail-cli/issues/45)

# [1.2.0](https://github.com/hacker-h/proton-mail-cli/compare/v1.1.2...v1.2.0) (2026-05-09)


### Bug Fixes

* **browser:** move default session path ([ab58a69](https://github.com/hacker-h/proton-mail-cli/commit/ab58a69f0a0a7d8c753bf706a33c47294775d726))
* merge main browser refactor with CLI config dispatch ([981eec3](https://github.com/hacker-h/proton-mail-cli/commit/981eec386dee2be74ca69538e3ef37ed6f7d186f))


### Features

* **cli:** add config doctor commands ([f522823](https://github.com/hacker-h/proton-mail-cli/commit/f52282342c4001ba66acf681e687d1b2397f3a09))

## [1.1.2](https://github.com/hacker-h/proton-mail-cli/compare/v1.1.1...v1.1.2) (2026-05-09)


### Bug Fixes

* **browser:** log temp cleanup failures ([a8720ee](https://github.com/hacker-h/proton-mail-cli/commit/a8720eec1609bc1bf728bf93c2b79ff8e8bccbc8))
* **cli:** type argument count helper ([0e1cd9e](https://github.com/hacker-h/proton-mail-cli/commit/0e1cd9e23d7962adf898a4d88729fc1105f2c0d8))
* harden browser observability ([2a74a94](https://github.com/hacker-h/proton-mail-cli/commit/2a74a94cffc2adf5cb61b407daa65bd25dccfe56))
* repair browser checkjs types ([90e3dc7](https://github.com/hacker-h/proton-mail-cli/commit/90e3dc739c1749cc7b222e99b7a6eab37902c16b))

## [1.1.1](https://github.com/hacker-h/proton-mail-cli/compare/v1.1.0...v1.1.1) (2026-05-09)


### Bug Fixes

* **browser:** log temp cleanup failures ([0e22b03](https://github.com/hacker-h/proton-mail-cli/commit/0e22b03ff11f2c2f30d4e676f6f2fb4f11a0362e))
* restore js typechecking ([9308854](https://github.com/hacker-h/proton-mail-cli/commit/93088549b0c697ae3fac4790fd6b70d347eec48e))

# [1.1.0](https://github.com/hacker-h/proton-mail-cli/compare/v1.0.1...v1.1.0) (2026-05-09)


### Features

* add pm CLI runner contract ([6d6df4d](https://github.com/hacker-h/proton-mail-cli/commit/6d6df4dad2ff932d01720a16a756c4ee1461dd4a))

## [1.0.1](https://github.com/hacker-h/proton-mail-cli/compare/v1.0.0...v1.0.1) (2026-05-09)


### Bug Fixes

* **browser:** signal expired saved sessions ([fe7f02e](https://github.com/hacker-h/proton-mail-cli/commit/fe7f02eed9b674ef2e880ddff4d2399dc9732f92))

# 1.0.0 (2026-05-09)


### Bug Fixes

* **browser:** correct Proton inbox selectors using live debug session ([8ce46a0](https://github.com/hacker-h/proton-mail-cli/commit/8ce46a06553919797b81027db7afc2e8e88935de))
* **browser:** log swallowed browser-client errors ([530df6e](https://github.com/hacker-h/proton-mail-cli/commit/530df6ef74321ccedb0faf0d3254d3647527f96f)), closes [#26](https://github.com/hacker-h/proton-mail-cli/issues/26)
* **browser:** tighten auth challenge detection ([2de386a](https://github.com/hacker-h/proton-mail-cli/commit/2de386a4f80f3a799d49bfa0452442fcda989093))
* **browser:** write session files with private mode ([d313447](https://github.com/hacker-h/proton-mail-cli/commit/d3134470c82fcff8528f4abd15e68fae1db50f18)), closes [#27](https://github.com/hacker-h/proton-mail-cli/issues/27)
* **debug:** clean shutdown and orphan prevention ([53e8556](https://github.com/hacker-h/proton-mail-cli/commit/53e8556e798074ca5403c0da8e398aaab89a5e3d))
* **debug:** return browser handle from loginAndSaveSession for clean CLI shutdown ([a794d5f](https://github.com/hacker-h/proton-mail-cli/commit/a794d5fb4d2be58c0994a8729f339f0f10d525a4))
* **debug:** use launchPersistentContext for user-data-dir support ([44624f0](https://github.com/hacker-h/proton-mail-cli/commit/44624f0fb1c3a6f856689a98a59922b585f74083))
* **http:** add rate-limit backoff ([e6bba89](https://github.com/hacker-h/proton-mail-cli/commit/e6bba89f39999a89f2df539c691ac29990a9c723))


### Features

* **browser:** add reusable Proton Mail browser client ([1ce674d](https://github.com/hacker-h/proton-mail-cli/commit/1ce674d56437f47768b82e5a1fa06ce4fc0832db))
* **debug:** add debug config resolver ([2de901f](https://github.com/hacker-h/proton-mail-cli/commit/2de901fdd58926bc65fd0ece5bda261d72245aec))
* **debug:** add debug-login CLI and npm script ([4b50541](https://github.com/hacker-h/proton-mail-cli/commit/4b50541d154830910379eafe650aa54862d72fdd))
* **debug:** add debugLogin convenience method ([97913fc](https://github.com/hacker-h/proton-mail-cli/commit/97913fcd65e3c1f72904c0ec75586c044cf5113d))
* **debug:** debug-aware launch and ensureLoggedIn lifecycle ([cedac28](https://github.com/hacker-h/proton-mail-cli/commit/cedac287f87cc490f5e2b6b6d5d9d1b51a2b048d))
* **debug:** suppress cooldown writes and keep browser open on error ([36f4924](https://github.com/hacker-h/proton-mail-cli/commit/36f49246e8a24d9457c8ef2e270a0202d181ffee))
* initial protonmail-api-client with cookie-session auth ([638d902](https://github.com/hacker-h/proton-mail-cli/commit/638d902446b0f983e593005bcc51044ef191e383))

# Changelog

Release notes are generated by semantic-release.
