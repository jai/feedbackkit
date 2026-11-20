import Foundation

/// What the menu bar icon says: all well, a message on its way, or a problem with the reason. A failed message is a
/// problem of its own, so the menu can offer to dismiss it.
public enum Health: Sendable, Equatable {
    case ok
    case working
    case problem(String)
    /// `key` is the message's `<chat>/<message>`.
    case failed(key: String, reason: String)

    /// A status.json older than this means the runner has stopped ticking (a full tick can take half a minute).
    public static let silentAfter: Double = 120
    /// A failed message counts as a problem for a day.
    public static let failedFor: Double = 86_400

    /// The first problem found, else working when any message is on its way or an agent works, else ok. A failed
    /// message whose key is in `dismissed` is no problem.
    public static func of(_ snapshot: Snapshot?, unreachable: String?, dismissed: Set<String>, now: Double) -> Health {
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
        if let problem = buildersProblem(status.builders) {
            return .problem(problem)
        }
        for chat in status.chats {
            let failed = chat.messages.first { message in
                message.state == "failed" && now - (message.at ?? 0) < failedFor && !dismissed.contains(chat.key(message))
            }
            if let failed {
                return .failed(key: chat.key(failed), reason: failed.detail ?? failed.id)
            }
        }
        let moving = status.chats.contains { chat in
            chat.working || chat.messages.contains { ["pending", "delivering", "queued"].contains($0.state) }
        }
        return moving ? .working : .ok
    }

    /// Why no new chat can start: every builder turned off, or none of those taking new chats answers.
    static func buildersProblem(_ builders: [RunnerStatus.Builder]) -> String? {
        guard !builders.isEmpty else { return nil }
        let on = builders.filter(\.on)
        if on.isEmpty {
            return "Every builder is turned off"
        }
        if on.contains(where: \.up) {
            return nil
        }
        return on.count == builders.count ? "No builder's Orca answers" : "No builder taking new chats answers"
    }

    public var symbol: String {
        switch self {
        case .ok: "bubble.left.and.bubble.right"
        case .working: "ellipsis.bubble"
        case .problem, .failed: "exclamationmark.bubble"
        }
    }

    public var summary: String {
        switch self {
        case .ok: "Runner OK"
        case .working: "Working on a message"
        case let .problem(reason): reason
        case let .failed(_, reason): "A message failed: \(reason)"
        }
    }
}

/// Failed messages Jai dismissed, by `<chat>/<message>`, with when. Kept in UserDefaults as a plist dictionary.
public struct Dismissed: Sendable, Equatable {
    /// A dismissal is forgotten after this, by then its message no longer counts as a problem anyway.
    public static let keptFor: Double = 2 * 86_400

    public var at: [String: Double]

    public init(_ at: [String: Double] = [:]) {
        self.at = at
    }

    public var keys: Set<String> { Set(at.keys) }

    public mutating func add(_ key: String, now: Double) {
        at[key] = now
    }

    /// Without the dismissals older than two days, and those of messages `status` no longer lists.
    public func pruned(by status: RunnerStatus, now: Double) -> Dismissed {
        let listed = Set(status.chats.flatMap { chat in chat.messages.map(chat.key) })
        return Dismissed(at.filter { key, at in now - at < Self.keptFor && listed.contains(key) })
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
