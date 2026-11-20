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

/// A row's accessory: one capsule in the tone of where the feedback is, naming the place — the open pull request,
/// main, or the release — with its checks' mark inside. The row's status already says the stage in words ("On main"),
/// so the capsule does not say it again (Jai, 2026-11-19: an outlined "On main" with a circled tick and a loose check
/// dot beside it read as a checkbox).
struct FeedbackShippedChips: View {
    @Environment(\.chatTheme) private var theme
    let shipped: FeedbackShipped

    var body: some View {
        HStack(spacing: ChatSpace.sm) {
            switch shipped.stage {
            case .pullRequestOpen?:
                let open = shipped.prs.filter { $0.state == .open }
                ForEach(open.isEmpty ? shipped.prs : open) { pr in
                    chip("PR #\(pr.number)", symbol: "arrow.trianglehead.pull", tint: tint(theme.toneWaiting),
                         checks: pr.checks, label: "Pull request \(pr.number), \(pr.state.rawValue)")
                }
            case .onMain?:
                chip("main", symbol: "arrow.trianglehead.merge", tint: tint(theme.inkQuiet), checks: shipped.checks,
                     label: "On main")
            case let .released(release)?:
                // The checks are the commits' own runs on main; the release ran its tests again and passed them, so
                // a check that failed before the release says nothing about it now.
                chip(release.name, symbol: "shippingbox.fill", tint: theme.toneGood, checks: nil,
                     label: "In \(release.name)")
            case nil:
                EmptyView()
            }
        }
        // Inside a row's button; the button reads these out with the rest of the row.
        .lineLimit(1)
    }

    /// A failed check turns the capsule red, until a release carries the commits.
    private func tint(_ stage: Color) -> Color {
        shipped.checks == .failure ? theme.toneBad : stage
    }

    /// The place in ink on a wash of the tone, the symbol in the tone, then the checks' mark. VoiceOver reads `label`
    /// and the checks' words: a label on the whole capsule would also replace the mark's own.
    private func chip(
        _ text: String, symbol: String, tint: Color, checks: FeedbackShipped.Checks?, label: String
    ) -> some View {
        HStack(spacing: ChatSpace.xs) {
            Image(systemName: symbol).foregroundStyle(tint)
            Text(text).foregroundStyle(theme.ink)
            if let checks {
                FeedbackChecksMark(checks: checks, style: .tick)
            }
        }
        .fontWeight(.medium)
        .padding(.horizontal, ChatSpace.sm)
        .padding(.vertical, 3)
        .background(tint.opacity(0.18), in: .capsule)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([label, checks.map(FeedbackChecksMark.words)].compactMap(\.self).joined(separator: ", "))
    }
}

/// A check's outcome as a mark, green, amber or red, with its words for VoiceOver: a filled circle on the chat's
/// header, a bare tick, clock or cross inside a row's capsule.
struct FeedbackChecksMark: View {
    enum Style { case circle, tick }
    @Environment(\.chatTheme) private var theme
    let checks: FeedbackShipped.Checks
    var style = Style.circle

    var body: some View {
        Image(systemName: symbol)
            .fontWeight(style == .tick ? .bold : nil)
            .imageScale(style == .tick ? .small : .medium)
            .foregroundStyle(checks == .failure ? theme.toneBad : checks == .pending ? theme.toneWaiting : theme.toneGood)
            .accessibilityLabel(Self.words(checks))
            .accessibilityIdentifier("feedback-shipped-checks-\(checks.rawValue)")
    }

    static func words(_ checks: FeedbackShipped.Checks) -> String {
        checks == .failure ? "Checks failed" : checks == .pending ? "Checks running" : "Checks passed"
    }

    private var symbol: String {
        switch (checks, style) {
        case (.failure, .circle): "xmark.circle.fill"
        case (.failure, .tick): "xmark"
        case (.pending, _): "clock"
        case (.success, .circle): "checkmark.circle.fill"
        case (.success, .tick): "checkmark"
        }
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
