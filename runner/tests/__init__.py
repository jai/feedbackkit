"""The runner's tests make git repositories of their own in temporary folders. Run from a git hook (`make check` at
pre-push), git's own variables (`GIT_DIR`, `GIT_INDEX_FILE`, ...) point every git the tests start at the repository
being pushed: `git init --bare` made it bare and `git config` gave it the tests' author. They go before any test runs."""

import os

for name in [name for name in os.environ if name.startswith("GIT_")]:
    del os.environ[name]
