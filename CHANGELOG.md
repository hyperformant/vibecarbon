> **This file is frozen at v0.41.0.** Release notes for later versions live on
> the [GitHub Releases page](https://github.com/hyperformant/vibecarbon/releases) —
> semantic-release no longer commits to `main` (its version-bump push conflicted
> with branch protection), so the changelog moved where the API can write.

# [0.41.0](https://github.com/hyperformant/vibecarbon/compare/v0.40.0...v0.41.0) (2026-08-23)


### Bug Fixes

* **compose-ha:** image failures fail at the image step — no silent pulls, no implicit builds ([36215e4](https://github.com/hyperformant/vibecarbon/commit/36215e47cabbc0632b3a24068592d797f2c574ae))
* **compose:** exclude the app service from the pre-pull — its local-only tag was aborting EVERY sibling pull ([0daf506](https://github.com/hyperformant/vibecarbon/commit/0daf5064db2e73db147fec22791ee66f22bf41c0))
* **destroy:** a deploy that died before its first save left destroy crashing instead of cleaning up ([2461b1a](https://github.com/hyperformant/vibecarbon/commit/2461b1abd69f668b338326bde9e6605ec9bfc242))
* **destroy:** the purge race's 180s timer held every destroy open ~3 min after Done ([2d2bb42](https://github.com/hyperformant/vibecarbon/commit/2d2bb429abbe9bf0e791ffc6684aec5e7ca63727))
* **e2e:** authenticate Pulumi plugin downloads — the vultr leg died on GitHub's anonymous rate budget ([56596bc](https://github.com/hyperformant/vibecarbon/commit/56596bc17e2aec4373dc63759adc6b12e10aba45))
* **e2e:** frontend_render died to its own absorbed goto — navigation race retried, not fatal ([b6240ad](https://github.com/hyperformant/vibecarbon/commit/b6240ad667ee60a099819c1be48d5d2de1ae2bd9))
* **k8s-ha:** reap stale worker Node objects on the pilot standby — VM deletion never removed them ([8b311b4](https://github.com/hyperformant/vibecarbon/commit/8b311b47fa715a86435e15b4381877af401d2c3f))
* **k8s:** retry ladder never engaged on the webhook broken-pipe — no classifier knew the spelling ([63c32a6](https://github.com/hyperformant/vibecarbon/commit/63c32a604e60ed926531e2b7d8eaea16a5b4a8f2))
* **perf:** publish the CLI's own wall, not the step wall — and name lingering handles ([bd17cd3](https://github.com/hyperformant/vibecarbon/commit/bd17cd302c8795f2c4329a7c7f3ac8708e59d6dd))
* **provision:** raise sshd MaxStartups on every node — our deploys fan more concurrent ssh than Ubuntu's default admits ([f9cc839](https://github.com/hyperformant/vibecarbon/commit/f9cc8399ba69d9fec2a2e0c2ee1712a228778244))
* **remote-build:** classify docker's dial-stdio ssh death as transient + capture ssh evidence at exhaustion ([239e7c9](https://github.com/hyperformant/vibecarbon/commit/239e7c9a8aa0d3ed031989aadf30ea7d99d08e85))
* **remote-build:** multiplex the build's ssh over one master connection — the MaxStartups countermeasure ([d875ecb](https://github.com/hyperformant/vibecarbon/commit/d875ecbf929529b06bc6fff3bc7a408e0fbdb957))
* **template:** CSP silently blocked every Plausible event — configure analytics never worked ([b9dcfba](https://github.com/hyperformant/vibecarbon/commit/b9dcfbafeceadea08bc37bba40aaf2657aa515f7))
* **template:** GitHub stars button is opt-in via VITE_GITHUB_REPO_URL — no phone-home by default ([075a91d](https://github.com/hyperformant/vibecarbon/commit/075a91dfc33e2d2903ef3d4a44db0e4c988a4891))


### Features

* **perf:** publish failover — the vendor-matrix tab was typed and waiting, emission was the missing piece ([610137a](https://github.com/hyperformant/vibecarbon/commit/610137a88ba8acdc4669ef7d9f7c2409d470fd37))
* **template:** landing refresh — GitHub stars button, install-first hero, new messaging ([338df68](https://github.com/hyperformant/vibecarbon/commit/338df68ba5f023b9648061cf9af061fcb9ffa192))

# [0.40.0](https://github.com/hyperformant/vibecarbon/compare/v0.39.15...v0.40.0) (2026-08-23)


### Bug Fixes

* **ci:** git hooks must not run in CI — a local gate killed the release ([e536ec4](https://github.com/hyperformant/vibecarbon/commit/e536ec47a32b1e17e572cf0e54aa1536c5eb2d47))
* **ci:** prepublishOnly must not run the suite in CI — the second gate killing the release ([8b03ad1](https://github.com/hyperformant/vibecarbon/commit/8b03ad14615c4594ed27d7914f03ca80987686df))
* **ci:** stored credential names ARE the names src/ reads — delete the translation layer ([a175e9d](https://github.com/hyperformant/vibecarbon/commit/a175e9dfde81d4e751da9d5dc52245f2c688f5cc))
* **deploy:** client build args must agree with the .env the server runs ([04b240b](https://github.com/hyperformant/vibecarbon/commit/04b240b1c167c75f5a94418b0b978a534c5c0021))


### Features

* **deploy:** warn when runtime keys live only in .env.local ([66d6dc9](https://github.com/hyperformant/vibecarbon/commit/66d6dc96825e2ae52c341064acf9b3b188023210))

## [0.39.16](https://github.com/hyperformant/vibecarbon/compare/v0.39.15...v0.39.16) (2026-08-23)


### Bug Fixes

* **ci:** git hooks must not run in CI — a local gate killed the release ([e536ec4](https://github.com/hyperformant/vibecarbon/commit/e536ec47a32b1e17e572cf0e54aa1536c5eb2d47))
* **ci:** stored credential names ARE the names src/ reads — delete the translation layer ([a175e9d](https://github.com/hyperformant/vibecarbon/commit/a175e9dfde81d4e751da9d5dc52245f2c688f5cc))
