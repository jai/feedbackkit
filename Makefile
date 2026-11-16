# >>> repo header
# jai/feedbackkit: the root Makefile (new). Built from jai/ci makefile.template; regenerate with jai/ci makefiles/sync.py.
#
# Languages: Swift (Sources/, Tests/, Demo/, runner/MenuBar/), TypeScript (worker/, sample-worker/), Python (runner/),
# shell (deploy/, runner/MenuBar/).
#
# runner/ runs on Homebrew's Python 3.14 (runner/install.py): mise.toml pins python 3.14, and uv for Pyrefly.
# runner/Makefile stays; its LaunchAgent drift check is `install-check`, so the root `check` is only the code check.
# The worker type checks read src/ only, as tsc -p tsconfig.json did: the tests run on node --test.
# SWIFT_TEST_ARGS: CI skips the Live suites (`--skip ...`), which die with SIGBUS on GitHub's macOS 26 runner.
# The demo app's builds and UI tests, the API break check and the menu bar bundle stay in CI (ci.yml).
# <<< repo header
#
# Standard targets (jai/ci docs/make-targets.md):
#   make setup       tools, dependencies and git hooks; safe to run again
#   make fmt         format every file in place
#   make lint        format check and fast linters on all files; changes nothing (git pre-commit hook, CI Lint)
#   make typecheck   type checks and type-aware lint rules (CI Lint)
#   make test        unit tests: no network, no outside services (CI Unit Tests)
#   make check       lint, then typecheck and test for the parts that changed against origin/main (git pre-push hook)
#   make             same as make check
#
# Keep to GNU Make 3.81, the version macOS ships: no .ONESHELL, no .SHELLFLAGS, no $(file ...).
# A recipe line that fails stops the target. Put `set -o pipefail;` in front of any line with a pipe.
# Everything outside the two "repo" blocks comes from jai/ci makefile.template; change it there.

SHELL := /bin/bash
.DEFAULT_GOAL := check
.PHONY: setup fmt lint typecheck test check

# Tools. mise (https://mise.jdx.dev) installs each pinned tool on first use, so a target works in a fresh clone, a new
# worktree and a CI job alike. Runtimes (node, go, python) come from the repo's mise.toml or .tool-versions.
X := mise exec
RUN := $(X) --
# At most 4 parallel jobs on Jai's Macs (RULES.md): an uncapped hook held Cube 03 at 0% idle on 2026-11-16. Go tools
# (go test, go vet, golangci-lint) take GOMAXPROCS. Give a part's other runners $(JOBS): vitest and jest
# --maxWorkers=$(JOBS), xcodebuild -jobs $(JOBS), Gradle --max-workers=$(JOBS), golangci-lint --concurrency=$(JOBS).
JOBS := 4
export GOMAXPROCS := $(JOBS)
PREK        := $(X) prek@0.5.10 -- prek
ACTIONLINT  := $(X) actionlint@1.7.12 -- actionlint
GITLEAKS    := $(X) gitleaks@8.30.1 -- gitleaks
SHELLCHECK  := $(X) shellcheck@0.11.0 -- shellcheck
SHFMT       := $(X) shfmt@3.14.1 -- shfmt
# TypeScript and JavaScript. oxfmt needs no project setup, so it runs pinned from npm. oxlint, oxlint-tsgolint and
# typescript@7 are devDependencies of each package (lockfile-pinned): type-aware rules and --type-check need them there.
# OXLINT_NPX is for files outside any package.
OXFMT       := npx --yes oxfmt@0.78.0 --threads=$(JOBS)
OXLINT      := npx --no-install oxlint --threads=$(JOBS)
OXLINT_NPX  := npx --yes oxlint@1.93.0 --threads=$(JOBS)
# Python
RUFF        := $(X) ruff@0.17.5 -- ruff
# pipx: tools need uv on the machine: pin it in the repo's mise.toml or .tool-versions (uv 0.9 or later).
PYREFLY     := $(X) pipx:pyrefly@1.4.1 -- pyrefly
# Go. golangci-lint v2 also formats (`golangci-lint fmt`, formatters set in .golangci.yml).
GOLANGCI    := $(X) golangci-lint@2.15.0 -- golangci-lint
# Swift
SWIFTFORMAT := $(X) swiftformat@0.64.7 -- swiftformat
SWIFTLINT   := $(X) swiftlint@0.65.1 -- swiftlint
# PHP. Mago formats, lints and analyses in one binary.
MAGO        := $(X) mago@1.60.1 -- mago
# Terraform
TERRAFORM   := $(X) terraform@1.17.2 -- terraform
TFLINT      := $(X) tflint@0.66.0 -- tflint
# Security scanners, for the optional `security` target.
TRIVY       := $(X) trivy@0.76.2 -- trivy
OSV         := $(X) osv-scanner@2.3.8 -- osv-scanner
SEMGREP     := $(X) pipx:semgrep@1.151.0 -- semgrep

# Changed files, for `check`: committed since origin/main, uncommitted, and untracked.
# The default branch's tip, from origin/HEAD (master in ramen-beast-web); origin/main when origin/HEAD is not set.
BASE ?= $(or $(shell git rev-parse --abbrev-ref origin/HEAD 2>/dev/null),origin/main)
CHANGED := $(shell git diff --name-only $(BASE)...HEAD 2>/dev/null; git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null)
# A change to one of these runs every part.
EVERYTHING := Makefile mise.toml .tool-versions .pre-commit-config.yaml
# $(strip): Make 3.81 counts a blank $(if) condition as true, so with no part changed `make check` would loop.
changed_parts = $(strip $(if $(filter $(EVERYTHING),$(CHANGED)),$(PARTS),$(foreach p,$(PARTS),$(if $(filter $($(p)_PATHS),$(CHANGED)),$(p)))))

# Shell scripts by shebang. ShellCheck and shfmt read bash and sh; zsh scripts get `zsh -n`.
SH_FILES = $(shell git ls-files '*.sh' | xargs grep -l -E '^\#!.*(bash|/sh)' 2>/dev/null)
ZSH_FILES = $(shell git ls-files '*.sh' '*.zsh' | xargs grep -l -E '^\#!.*zsh' 2>/dev/null)

# >>> repo parts
PARTS := kit menubar worker sample runner

SWIFT_TEST_ARGS ?=
kit_PATHS := Sources/% Tests/% Demo/% Package.swift Package.resolved .swiftformat .swiftlint.yml
.PHONY: kit-setup kit-fmt kit-lint kit-typecheck kit-test
kit-setup:
	@:
kit-fmt:
	$(SWIFTFORMAT) Sources Tests Demo runner/MenuBar Package.swift
kit-lint:
	$(SWIFTFORMAT) Sources Tests Demo runner/MenuBar Package.swift --lint
	$(SWIFTLINT) lint --strict --quiet
kit-typecheck:
	swift build -j $(JOBS)
kit-test:
	swift test -j $(JOBS) $(SWIFT_TEST_ARGS)

# The runner's menu bar app: its own Swift package. kit-fmt and kit-lint cover its files.
menubar_PATHS := runner/MenuBar/%
.PHONY: menubar-setup menubar-fmt menubar-lint menubar-typecheck menubar-test
menubar-setup menubar-fmt menubar-lint:
	@:
menubar-typecheck:
	cd runner/MenuBar && swift build -j $(JOBS)
menubar-test:
	cd runner/MenuBar && swift test -j $(JOBS)

worker_PATHS := worker/% .oxfmtrc.json
.PHONY: worker-setup worker-fmt worker-lint worker-typecheck worker-test
worker-setup:
	npm --prefix worker ci --no-audit --no-fund
worker-fmt:
	$(OXFMT) worker
worker-lint:
	$(OXFMT) --check worker
	cd worker && $(OXLINT) --deny-warnings
worker-typecheck:
	cd worker && $(OXLINT) --type-aware --type-check --deny-warnings src
worker-test:
	npm --prefix worker test

# sample-worker/ type-checks worker/src/token.ts too (its tsconfig.json).
sample_PATHS := sample-worker/% worker/src/token.ts .oxfmtrc.json
.PHONY: sample-setup sample-fmt sample-lint sample-typecheck sample-test
sample-setup:
	npm --prefix sample-worker ci --no-audit --no-fund
sample-fmt:
	$(OXFMT) sample-worker
sample-lint:
	$(OXFMT) --check sample-worker
	cd sample-worker && $(OXLINT) --deny-warnings
sample-typecheck:
	cd sample-worker && $(OXLINT) --type-aware --type-check --deny-warnings src
sample-test:
	npm --prefix sample-worker test

runner_PATHS := runner/feedbackkit_runner/% runner/tests/% runner/prompts/% runner/install.py runner/Makefile \
	runner/pyrefly.toml ruff.toml
.PHONY: runner-setup runner-fmt runner-lint runner-typecheck runner-test
runner-setup:
	@:
runner-fmt:
	$(RUFF) format runner
runner-lint:
	$(RUFF) format --check runner
	$(RUFF) check runner
runner-typecheck:
	cd runner && $(PYREFLY) check
runner-test:
	$(RUN) $(MAKE) -C runner test
# <<< repo parts

# Repo-wide: GitHub workflows, shell scripts, and secrets in the staged changes.
.PHONY: repo-fmt repo-lint
repo-fmt:
	$(if $(SH_FILES),$(SHFMT) -w $(SH_FILES),@:)
repo-lint:
	$(ACTIONLINT)
	$(if $(SH_FILES),$(SHFMT) -d $(SH_FILES),@:)
	$(if $(SH_FILES),$(SHELLCHECK) $(SH_FILES),@:)
	$(foreach f,$(ZSH_FILES),zsh -n $(f) &&) :
	$(GITLEAKS) git --pre-commit --staged --redact --no-banner

# mise reads the repo's mise.toml or .tool-versions only once the clone trusts it. CI sets
# MISE_TRUSTED_CONFIG_PATHS to the workspace instead.
.PHONY: mise-trust
mise-trust:
	mise trust --quiet
# The standard targets.
setup: mise-trust $(addsuffix -setup,$(PARTS))
	$(PREK) install --hook-type pre-commit --hook-type pre-push
fmt: repo-fmt $(addsuffix -fmt,$(PARTS))
lint: repo-lint $(addsuffix -lint,$(PARTS))
typecheck: $(addsuffix -typecheck,$(PARTS))
test: $(addsuffix -test,$(PARTS))
check: lint
	$(if $(changed_parts),$(MAKE) -f $(firstword $(MAKEFILE_LIST)) $(addsuffix -typecheck,$(changed_parts)) $(addsuffix -test,$(changed_parts)),@echo "check: no part changed against $(BASE)")
