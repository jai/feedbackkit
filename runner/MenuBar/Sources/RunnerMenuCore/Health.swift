import Foundation

/// What the menu bar icon says: all well, a message on its way, or a problem with the reason.
public enum Health: Sendable, Equatable {
    case ok
    case working
    case problem(String)

    /// A status.json older than this means the runner has stopped ticking (a full tick can take half a minute).
    public static let silentAfter: Double = 120
    /// A failed message counts as a problem for a day.
    public static let failedFor: Double = 86_400

    /// The first problem found, else working when any message is on its way or an agent works, else ok.
    public static func of(_ snapshot: Snapshot?, unreachable: String?, now: Double) -> Health {
        if let unreachable {
            return .problem("Mac mini unreachable: \(unreachable)")
        }
        guard let snapshot else {
            return .problem("Not checked yet")
        }
        guard snapshot.loaded else {
            return .problem("Runner not loaded on the Mac mini")
        }
        guard let status = snapshot.status else {
            return .problem(snapshot.statusError ?? "No status")
        }
        let age = now - status.writtenAt
        if age > silentAfter {
            return .problem("Runner silent for \(Int(age / 60)) min")
        }
        if let poll = status.poll, !poll.ok {
            return .problem("FeedbackKit Worker unreachable: \(poll.error ?? "no answer")")
        }
        if !status.builders.isEmpty, !status.builders.contains(where: \.up) {
            return .problem("No builder's Orca answers")
        }
        let failed = status.chats.lazy.flatMap(\.messages)
            .first { $0.state == "failed" && now - ($0.at ?? 0) < failedFor }
        if let failed {
            return .problem("A message failed: \(failed.detail ?? failed.id)")
        }
        let moving = status.chats.contains { chat in
            chat.working || chat.messages.contains { ["pending", "delivering", "queued"].contains($0.state) }
        }
        return moving ? .working : .ok
    }

    public var symbol: String {
        switch self {
        case .ok: "bubble.left.and.bubble.right"
        case .working: "ellipsis.bubble"
        case .problem: "exclamationmark.bubble"
        }
    }

    public var summary: String {
        switch self {
        case .ok: "Runner OK"
        case .working: "Working on a message"
        case let .problem(reason): reason
        }
    }
}

/// `agentpager://thread/<host>/<id>`: Agent Pager opens that coding thread (Orca has no link to a remote worktree).
public func threadLink(_ thread: RunnerStatus.Thread) -> URL? {
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove(charactersIn: "/")
    guard
        let host = thread.host.addingPercentEncoding(withAllowedCharacters: allowed),
        let id = thread.id.addingPercentEncoding(withAllowedCharacters: allowed)
    else { return nil }
    return URL(string: "agentpager://thread/\(host)/\(id)")
}

/// "12 s ago", "4 min ago", "3 h ago".
public func ago(_ at: Double?, now: Double) -> String {
    guard let at else { return "never" }
    let seconds = max(0, Int(now - at))
    if seconds < 60 { return "\(seconds) s ago" }
    if seconds < 3600 { return "\(seconds / 60) min ago" }
    return "\(seconds / 3600) h ago"
}
