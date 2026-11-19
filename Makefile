# FeedbackKit ships the SDK, Worker and runner together from one tested vX.Y.Z source release.
# Named targets separate the test layers. Preparation is explicit; hooks run units only.
SHELL := /bin/bash
.DEFAULT_GOAL := test-unit-kit
.PHONY: setup

# Tools. mise (https://mise.jdx.dev) installs each pinned tool on first use, so a target works in a fresh clone, a new
# worktree and a CI job alike. Runtimes (node, go, python) come from the repo's mise.toml or .tool-versions.
X := mise exec
RUN := $(X) --
# Bound local build parallelism.
JOBS ?= 4
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
SWIFTFORMAT := $(X) swiftformat@0.64.7 -- swiftformat
SWIFTLINT := $(X) swiftlint@0.65.1 -- swiftlint
PYTHON := .venv/bin/python -I
unexport $(shell git rev-parse --local-env-vars 2>/dev/null)

# Shell scripts by shebang. ShellCheck and shfmt read bash and sh; zsh scripts get `zsh -n`.
SH_FILES = $(shell git ls-files '*.sh' | xargs grep -l -E '^\#!.*(bash|/sh)' 2>/dev/null)
ZSH_FILES = $(shell git ls-files '*.sh' '*.zsh' | xargs grep -l -E '^\#!.*zsh' 2>/dev/null)

PARTS := kit menubar worker sample runner

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
	swift test -j $(JOBS) --filter FeedbackKitTests

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
	npm --prefix worker run test:unit

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
	npm --prefix sample-worker run test:unit

runner_PATHS := runner/feedbackkit_runner/% runner/tests/% runner/prompts/% runner/install.py runner/Makefile \
	runner/pyrefly.toml ruff.toml
.PHONY: runner-setup runner-fmt runner-lint runner-typecheck runner-test
runner-setup:
	$(X) uv@0.13.8 -- uv venv --python 3.14 .venv
	$(X) uv@0.13.8 -- uv pip install --python .venv/bin/python -r requirements-test.txt
runner-fmt:
	$(RUFF) format runner
runner-lint:
	$(RUFF) format --check runner
	$(RUFF) check runner
runner-typecheck:
	cd runner && $(PYREFLY) check
runner-test:
	$(PYTHON) -m pytest -q -p no:cacheprovider --disable-socket runner/tests/unit

# Repo-wide: GitHub workflows, shell scripts, and secrets in the staged changes.
.PHONY: repo-fmt repo-lint
repo-fmt:
	$(if $(SH_FILES),$(SHFMT) -w $(SH_FILES),@:)
repo-lint:
	$(if $(SH_FILES),$(SHFMT) -d $(SH_FILES),@:)
	$(if $(SH_FILES),$(SHELLCHECK) $(SH_FILES),@:)
	$(foreach f,$(ZSH_FILES),zsh -n $(f) &&) :

.PHONY: setup lint-kit lint-workflows lint all-tests test-unit-kit test-integration-kit test-ui-kit fix
setup: $(addsuffix -setup,$(PARTS))
	$(PREK) install --hook-type pre-commit --hook-type pre-push
lint-workflows:
	$(ACTIONLINT)
lint-kit: repo-lint kit-lint worker-lint sample-lint runner-lint kit-typecheck menubar-typecheck worker-typecheck sample-typecheck runner-typecheck
	base=$$(git tag -l 'v[0-9]*' --sort=-v:refname | head -1); test -n "$$base"; swift package -j $(JOBS) diagnose-api-breaking-changes "$$base" --products FeedbackKit
lint: lint-kit lint-workflows

test-unit-kit: kit-test menubar-test worker-test sample-test runner-test

test-integration-kit:
	swift test -j $(JOBS) --filter FeedbackKitIntegrationTests
	npm --prefix worker run test:integration
	$(PYTHON) -m pytest -q -p no:cacheprovider runner/tests/integration

PLATFORM ?= ios
SIMULATOR ?=
UI_SCHEME = $(if $(filter mac,$(PLATFORM)),FeedbackDemoMac,FeedbackDemo)
UI_PLAN = $(if $(filter mac,$(PLATFORM)),SDK-macOS,SDK-iOS)
COMMA := ,
UI_DESTINATION = $(if $(filter mac,$(PLATFORM)),platform=macOS,platform=iOS Simulator$(COMMA)id=$(SIMULATOR))
test-ui-kit:
	xcodebuild test -project Demo/FeedbackDemo.xcodeproj -scheme $(UI_SCHEME) -testPlan $(UI_PLAN) \
		-destination '$(UI_DESTINATION)' -derivedDataPath tmp/ui-$(PLATFORM) -clonedSourcePackagesDirPath tmp/swift-packages \
		-resultBundlePath tmp/ui-$(PLATFORM).xcresult -parallel-testing-enabled NO \
		-retry-tests-on-failure -test-iterations 2 -jobs $(JOBS)
all-tests: test-unit-kit test-integration-kit test-ui-kit

# Use formatter/linter native fixes only on the requested files. The hook adds their changes to the index.
fix:
	$(if $(filter %.swift,$(FILES)),$(SWIFTFORMAT) $(filter %.swift,$(FILES)),@:)
	$(if $(filter %.py,$(FILES)),$(RUFF) check --fix $(filter %.py,$(FILES)),@:)
	$(if $(filter %.py,$(FILES)),$(RUFF) format $(filter %.py,$(FILES)),@:)
	$(if $(filter worker/%.ts worker/%.mjs,$(FILES)),cd worker && $(OXLINT) --fix --deny-warnings $(patsubst worker/%,%,$(filter worker/%.ts worker/%.mjs,$(FILES))),@:)
	$(if $(filter sample-worker/%.ts sample-worker/%.mjs,$(FILES)),cd sample-worker && $(OXLINT) --fix --deny-warnings $(patsubst sample-worker/%,%,$(filter sample-worker/%.ts sample-worker/%.mjs,$(FILES))),@:)
	$(if $(filter %.ts %.js %.mjs %.json,$(FILES)),$(OXFMT) $(filter %.ts %.js %.mjs %.json,$(FILES)),@:)
	$(if $(filter %.sh,$(FILES)),$(SHFMT) -w $(filter %.sh,$(FILES)),@:)
