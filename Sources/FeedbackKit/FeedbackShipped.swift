import AgentChatKit
import SwiftUI

/// What a feedback chat shipped (docs/api.md#shipped): the commits its agent landed on main, the pull requests it
/// opened, their checks, and the first release that carries each commit. The runner finds it; the Worker serves it on
/// the list's rows and on the chat.
public struct FeedbackShipped: Decodable, Equatable, Hashable, Sendable {
    /// A check's outcome: running, passed or failed.
    public enum Checks: String, Decodable, Sendable {
        case pending, success, failure
    }

    /// The first published GitHub Release whose tag contains the commit.
    public struct Release: Decodable, Equatable, Hashable, Sendable {
        public let tag: String
        public let name: String
        public let url: URL
        public let prerelease: Bool

        public init(tag: String, name: String, url: URL, prerelease: Bool = false) {
            self.tag = tag
            self.name = name
            self.url = url
            self.prerelease = prerelease
        }
    }

    public struct Commit: Decodable, Equatable, Hashable, Identifiable, Sendable {
        public let sha: String
        public let title: String
        public let url: URL
        public let checks: Checks?
        /// None yet: on main, in no release.
        public let release: Release?
        public var id: String { sha }

        private enum CodingKeys: String, CodingKey { case sha, title, url, ci, release }

        public init(from decoder: any Decoder) throws {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            sha = try fields.decode(String.self, forKey: .sha)
            title = try fields.decode(String.self, forKey: .title)
            url = try fields.decode(URL.self, forKey: .url)
            checks = try? fields.decodeIfPresent(Checks.self, forKey: .ci)
            release = try? fields.decodeIfPresent(Release.self, forKey: .release)
        }

        public init(sha: String, title: String, url: URL, checks: Checks?, release: Release?) {
            self.sha = sha
            self.title = title
            self.url = url
            self.checks = checks
            self.release = release
        }
    }

    public struct PullRequest: Decodable, Equatable, Hashable, Identifiable, Sendable {
        public enum State: String, Decodable, Sendable {
            case open, merged, closed
        }

        public let number: Int
        public let title: String
        public let url: URL
        public let state: State
        public let checks: Checks?
        public var id: Int { number }

        private enum CodingKeys: String, CodingKey { case number, title, url, state, ci }

        public init(from decoder: any Decoder) throws {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            number = try fields.decode(Int.self, forKey: .number)
            title = try fields.decode(String.self, forKey: .title)
            url = try fields.decode(URL.self, forKey: .url)
            state = try fields.decode(State.self, forKey: .state)
            checks = try? fields.decodeIfPresent(Checks.self, forKey: .ci)
        }

        public init(number: Int, title: String, url: URL, state: State, checks: Checks?) {
            self.number = number
            self.title = title
            self.url = url
            self.state = state
            self.checks = checks
        }
    }

    public let commits: [Commit]
    public let prs: [PullRequest]

    public init(commits: [Commit], prs: [PullRequest]) {
        self.commits = commits
        self.prs = prs
    }

    /// Where the feedback stands, as the docs name it (docs/api.md#shipped). Nil: nothing shipped yet.
    public enum Stage: Equatable, Sendable {
        case pullRequestOpen
        case onMain
        case released(Release)
    }

    public var stage: Stage? {
        if prs.contains(where: { $0.state == .open }), commits.isEmpty { return .pullRequestOpen }
        guard let newest = commits.first else { return prs.isEmpty ? nil : .pullRequestOpen }
        if commits.contains(where: { $0.release == nil }) { return .onMain }
        return newest.release.map(Stage.released)
    }

    /// The checks of everything it shipped, together: failed when any failed, running when any runs.
    public var checks: Checks? {
        let all = commits.compactMap(\.checks) + prs.compactMap(\.checks)
        if all.contains(.failure) { return .failure }
        if all.contains(.pending) { return .pending }
        return all.isEmpty ? nil : .success
    }

    /// Nothing at all: the runner looked and found no commit and no pull request.
    var isEmpty: Bool { commits.isEmpty && prs.isEmpty }

    /// A list row's or a chat's `shipped`; a malformed one is none, never a failed list.
    static func decodeLenient<Key: CodingKey>(_ fields: KeyedDecodingContainer<Key>, forKey key: Key) -> Self? {
        (try? fields.decodeIfPresent(Self.self, forKey: key)).flatMap { $0 }.flatMap { $0.isEmpty ? nil : $0 }
    }
}

extension FeedbackShipped.Stage {
    var label: String {
        switch self {
        case .pullRequestOpen: "PR open"
        case .onMain: "On main"
        case let .released(release): "In \(release.name)"
        }
    }
}

/// A row's accessories: where the feedback stands (PR open, on main, in a release), its checks, and each pull request.
struct FeedbackShippedChips: View {
    @Environment(\.chatTheme) private var theme
    let shipped: FeedbackShipped

    var body: some View {
        HStack(spacing: ChatSpace.sm) {
            if let stage = shipped.stage {
                chip(stage.label, symbol: stageSymbol(stage), tint: stageTint(stage))
            }
            if let checks = shipped.checks {
                FeedbackChecksMark(checks: checks)
            }
            ForEach(shipped.prs) { pr in
                chip("#\(pr.number)", symbol: pr.state == .merged ? "arrow.triangle.merge" : "arrow.triangle.pull",
                     tint: theme.inkQuiet)
                    .accessibilityLabel("Pull request \(pr.number), \(pr.state.rawValue)")
            }
        }
        // Inside a row's button; the button reads these out with the rest of the row.
        .lineLimit(1)
    }

    /// The words in ink, the symbol in the stage's tone: the words stay readable whatever a host's tones are.
    private func chip(_ text: String, symbol: String, tint: Color) -> some View {
        Label {
            Text(text).foregroundStyle(theme.ink)
        } icon: {
            Image(systemName: symbol).foregroundStyle(tint)
        }
        .padding(.horizontal, ChatSpace.sm)
        .padding(.vertical, 2)
        .overlay(Capsule().strokeBorder(theme.line))
    }

    private func stageSymbol(_ stage: FeedbackShipped.Stage) -> String {
        switch stage {
        case .pullRequestOpen: "arrow.triangle.pull"
        case .onMain: "checkmark.circle"
        case .released: "shippingbox"
        }
    }

    private func stageTint(_ stage: FeedbackShipped.Stage) -> Color {
        switch stage {
        case .pullRequestOpen: theme.toneWaiting
        case .onMain: theme.ink
        case .released: theme.toneGood
        }
    }
}

/// A check's outcome as a mark: a dot that is green, amber or red, with its words for VoiceOver.
struct FeedbackChecksMark: View {
    @Environment(\.chatTheme) private var theme
    let checks: FeedbackShipped.Checks

    var body: some View {
        Image(systemName: checks == .failure ? "xmark.circle.fill" : checks == .pending ? "clock" : "checkmark.circle.fill")
            .foregroundStyle(checks == .failure ? theme.toneBad : checks == .pending ? theme.toneWaiting : theme.toneGood)
            .accessibilityLabel(checks == .failure ? "Checks failed" : checks == .pending ? "Checks running" : "Checks passed")
            .accessibilityIdentifier("feedback-shipped-checks-\(checks.rawValue)")
    }
}

/// The chat's header: each commit and pull request with its link and checks, and where the feedback stands.
struct FeedbackShippedSection: View {
    @Environment(\.chatTheme) private var theme
    let shipped: FeedbackShipped

    var body: some View {
        VStack(alignment: .leading, spacing: ChatSpace.xs) {
            HStack(spacing: ChatSpace.sm) {
                Text("Shipped").font(theme.font(.footnote).weight(.semibold))
                if let stage = shipped.stage {
                    Text(stage.label).foregroundStyle(theme.inkQuiet)
                        .accessibilityIdentifier("feedback-shipped-header-stage")
                }
            }
            ForEach(shipped.prs) { pr in
                Link(destination: pr.url) {
                    line("#\(pr.number) \(pr.title)", detail: pr.state.rawValue.capitalized, checks: pr.checks)
                }
                .accessibilityIdentifier("feedback-shipped-header-pr-\(pr.number)")
            }
            ForEach(shipped.commits) { commit in
                Link(destination: commit.url) {
                    line("\(commit.sha.prefix(7)) \(commit.title)", detail: commit.release?.name ?? "On main",
                         checks: commit.checks)
                }
                .accessibilityIdentifier("feedback-shipped-header-commit-\(commit.sha.prefix(7))")
            }
        }
        .font(theme.font(.footnote))
        .padding(ChatSpace.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.groundCard, in: .rect(cornerRadius: ChatRadius.md))
        .padding(.horizontal, ChatSpace.lg)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("feedback-shipped-header")
    }

    private func line(_ text: String, detail: String, checks: FeedbackShipped.Checks?) -> some View {
        HStack(spacing: ChatSpace.sm) {
            if let checks { FeedbackChecksMark(checks: checks) }
            Text(text).lineLimit(1).truncationMode(.tail).foregroundStyle(theme.ink)
            Spacer(minLength: ChatSpace.sm)
            Text(detail).foregroundStyle(theme.inkQuiet).lineLimit(1)
        }
    }
}
