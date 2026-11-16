# Changelog

## [0.7.0](https://github.com/jai/feedbackkit/compare/v0.6.1...v0.7.0) (2026-11-16)


### Features

* **runner:** the runner keeps itself current — hourly, between ticks, it installs the newest FeedbackKit release that changes runner/: fetch, test, install.py, restart through launchd ([#11](https://github.com/jai/feedbackkit/issues/11)) ([a22556f](https://github.com/jai/feedbackkit/commit/a22556f928257b8367df51187b8ce58ede0f9760))
* **runner:** the runner restarts onto Agent Pager's hub when the hub files it imported change, so it never runs an old hub after a reinstall ([#11](https://github.com/jai/feedbackkit/issues/11)) ([d8af962](https://github.com/jai/feedbackkit/commit/d8af96284b23557e696feb0d1d25e188fa13925e))


### Bug Fixes

* a legacy chat whose agent is idle is read every 15 s, not every 3 s ([#12](https://github.com/jai/feedbackkit/issues/12)) ([3373e04](https://github.com/jai/feedbackkit/commit/3373e04c643e566f3b954a5541b3602ed1cec4b3))
* **runner:** a self-update removes the releases it fetched before, so the update folder holds one release ([#11](https://github.com/jai/feedbackkit/issues/11)) ([43a8240](https://github.com/jai/feedbackkit/commit/43a82408629c156beb10e470f9a4ed2552efe9d0))

## [0.6.1](https://github.com/jai/feedbackkit/compare/v0.6.0...v0.6.1) (2026-11-16)


### Bug Fixes

* a Feedback screen hosted outside a SwiftUI scene goes live — the app's own state counts as foreground, not only scenePhase ([#9](https://github.com/jai/feedbackkit/issues/9)) ([7759ddf](https://github.com/jai/feedbackkit/commit/7759ddf298324ceba1f2a405abc812e85539cee6))
* **runner:** clones it prepares commit as jai@govindani.com, not the work address ([865d19e](https://github.com/jai/feedbackkit/commit/865d19eb34040a13f28b74e8217a452181398774))

## [0.6.0](https://github.com/jai/feedbackkit/compare/v0.5.0...v0.6.0) (2026-11-16)


### Features

* a message's screenshots show as thumbnails while it sends, and open on a tap ([#4](https://github.com/jai/feedbackkit/issues/4)) ([30836b7](https://github.com/jai/feedbackkit/commit/30836b724f2405fa64ee9fc2409b05e048ad520e))
