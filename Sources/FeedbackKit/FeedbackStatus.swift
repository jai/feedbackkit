import AgentChatKit
import SwiftUI

/// Where a feedback chat stands, as its row says it: queued, building, needs you, PR open, on main, checks failed,
/// released or idle. The agent's work comes first (queued, building); then a question it asked the sender, whatever it
/// shipped; then what it shipped; then whether it waits on the sender. An agent that stopped after it shipped without
/// asking is done, not waiting.
public enum FeedbackStatus: Equatable, Sendable {
    /// A message waits for the runner or the agent's next turn.
    case queued
    /// The agent is working on it.
    case building(activity: String?)
    /// The agent asked the sender a question; or it spoke last and stopped, and nothing shipped.
    case needsYou
    case pullRequestOpen
    /// Its commits are on main and in no release yet.
    case onMain
    /// A check of what it shipped failed, and it is not released.
    case checksFailed
    case released(FeedbackShipped.Release)
    case idle

    /// Nil: the Worker served neither (an issue chat, or a Worker before agent states).
    public init?(agent: FeedbackThreadAgent?, shipped: FeedbackShipped?) {
        if let agent, agent.state == .working {
            self = agent.isQueued ? .queued : .building(activity: agent.activity)
            return
        }
        if let agent, agent.state == .needsYou, agent.asks {
            self = .needsYou
            return
        }
        if let shipped = shipped.flatMap(Self.init(shipped:)) {
            self = shipped
            return
        }
        switch agent?.state {
        case .needsYou: self = .needsYou
        case .idle: self = .idle
        default: return nil
        }
    }

    /// Nil: nothing shipped yet.
    private init?(shipped: FeedbackShipped) {
        switch shipped.stage {
        case let .released(release)?: self = .released(release)
        case _ where shipped.checks == .failure && shipped.stage != nil: self = .checksFailed
        case .onMain?: self = .onMain
        case .pullRequestOpen?: self = .pullRequestOpen
        case nil: return nil
        }
    }

    public var label: String {
        switch self {
        case .queued: "Queued"
        case .building: "Building"
        case .needsYou: "Needs you"
        case .pullRequestOpen: "PR open"
        case .onMain: "On main"
        case .checksFailed: "Checks failed"
        case .released: "Released"
        case .idle: "Idle"
        }
    }

    /// For accessibility identifiers and tests.
    public var key: String {
        switch self {
        case .queued: "queued"
        case .building: "building"
        case .needsYou: "needs_you"
        case .pullRequestOpen: "pr_open"
        case .onMain: "on_main"
        case .checksFailed: "checks_failed"
        case .released: "released"
        case .idle: "idle"
        }
    }
}

/// A row's status: a spinner while the agent builds, else a symbol, in the status's tone.
struct FeedbackStatusLabel: View {
    @Environment(\.chatTheme) private var theme
    let status: FeedbackStatus

    var body: some View {
        HStack(spacing: ChatSpace.xs) {
            if case .building = status {
                ProgressView().controlSize(.mini)
            } else if let symbol {
                Image(systemName: symbol).imageScale(.small)
            }
            Text(status.label)
        }
        .foregroundStyle(tint)
        .fontWeight(isLoud ? .semibold : nil)
        .chatTextStyle(.meta)
        .lineLimit(1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
        .accessibilityIdentifier("feedback-status-\(status.key)")
    }

    private var symbol: String? {
        switch status {
        case .queued: "clock"
        case .building, .idle: nil
        case .needsYou: nil
        case .pullRequestOpen: "arrow.triangle.pull"
        case .onMain: "arrow.triangle.merge"
        case .checksFailed: "xmark.circle.fill"
        case .released: "shippingbox.fill"
        }
    }

    private var tint: Color {
        switch status {
        case .queued, .building, .onMain, .idle: theme.inkQuiet
        case .needsYou, .pullRequestOpen: theme.toneWaiting
        case .checksFailed: theme.toneBad
        case .released: theme.toneGood
        }
    }

    private var isLoud: Bool {
        switch status {
        case .needsYou, .checksFailed, .released: true
        default: false
        }
    }

    private var accessibilityText: String {
        switch status {
        case let .building(activity?): "Building: \(activity)"
        case let .released(release): "Released in \(release.name)"
        default: status.label
        }
    }
}

/// A row's status. A tidied chat's agent can't take a reply: what it shipped, else Read-only.
struct FeedbackRowStatus: View {
    @Environment(\.chatTheme) private var theme
    let thread: FeedbackThread

    var body: some View {
        if let status = FeedbackStatus(agent: thread.ended ? nil : thread.agent, shipped: thread.shipped) {
            FeedbackStatusLabel(status: status)
        } else if thread.ended {
            Label("Read-only", systemImage: "lock")
                .labelStyle(.titleAndIcon)
                .imageScale(.small)
                .foregroundStyle(theme.inkQuiet)
                .chatTextStyle(.meta)
                .lineLimit(1)
                .accessibilityIdentifier("feedback-status-read_only")
        }
    }
}

/// The last line of a released feedback chat: which release carries it, linked to its notes. A host that shows its own
/// conversation puts it at the end (`FeedbackConversation.shipped`).
public struct FeedbackReleaseNote: View {
    @Environment(\.chatTheme) private var theme
    private let release: FeedbackShipped.Release

    public init(release: FeedbackShipped.Release) {
        self.release = release
    }

    /// Nil until everything the chat shipped is in a release.
    public init?(shipped: FeedbackShipped?) {
        guard case let .released(release)? = shipped?.stage else {
            return nil
        }
        self.release = release
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: ChatSpace.sm) {
            Image(systemName: "shippingbox.fill")
                .foregroundStyle(theme.toneGood)
            VStack(alignment: .leading, spacing: ChatSpace.xs) {
                Text("Released in \(Text(release.name).fontWeight(.semibold))")
                    .foregroundStyle(theme.ink)
                Link("Release notes", destination: release.url)
                    .foregroundStyle(theme.inkQuiet)
            }
            Spacer(minLength: 0)
        }
        .font(theme.font(.footnote))
        .padding(ChatSpace.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.groundCard, in: .rect(cornerRadius: ChatRadius.md))
        .padding(.horizontal, ChatSpace.lg)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("feedback-release-note")
    }
}
