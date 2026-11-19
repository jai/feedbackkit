# feedbackkit

Instructions for agents working in this repo.

## About this repo

README.md says what the package, the Worker and the demo are. What it leaves out:

- **Old names stay.** `OldNames.swift` keeps every `Feature*` name as a typealias without a deprecation: Agent Pager
  builds with warnings as errors and still uses them.
- **The demo's Xcode project is generated** from `Demo/project.yml` and gitignored. Edit the YAML and run `xcodegen`.
- **The demo UI tests use controlled data**, with a mock Worker or the local ACP dev host. They are UI/component
  checks, not deployed-system E2E. `Demo/SDK-iOS.xctestplan` and `Demo/SDK-macOS.xctestplan` include their complete
  UI targets. Update Feedback-owned screen text and accessibility assertions together; shared chat behavior belongs
  in AgentChatKit's tests.
- **Releases** use conventional commits and git-cliff through `generate-release-candidate.yml` and `release.yml`.
  Candidates run all required layers before a `vX.Y.Z` source release. The external clock starts candidate generation
  every three hours. Native workflows use the existing Zoomies lanes; release validation does not change host cordons.
- **Test commands and workflows** are documented in `docs/workflow.md`; hooks fix staged files, lint the component
  before commit and run isolated units before push. Integration, UI and deployed E2E remain separate.
