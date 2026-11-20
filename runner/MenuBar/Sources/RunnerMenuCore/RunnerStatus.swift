import Foundation

/// The runner's status.json on the Mac mini (runner/README.md#statusjson). Times are Unix seconds.
public struct RunnerStatus: Decodable, Sendable, Equatable {
    public struct Tick: Decodable, Sendable, Equatable {
        public var at: Double
        public var seconds: Double
    }

    public struct LongPoll: Decodable, Sendable, Equatable {
        public var on: Bool
        public var lastWake: Double?
        public var error: String?
    }

    public struct Poll: Decodable, Sendable, Equatable {
        public var at: Double
        public var ok: Bool
        public var error: String?
    }

    public struct Builder: Decodable, Sendable, Equatable, Identifiable {
        /// What the menu shows for a builder: turned off (it takes no new chat), or on with its Orca answering or not.
        public enum State: Sendable, Equatable {
            case off
            case up
            case down(String?)
        }

        public var host: String
        public var name: String
        public var up: Bool
        public var detail: String?
        /// Whether it takes new chats (builders.json). A runner from before builders.json leaves it out: on.
        public var on: Bool
        public var id: String { host }

        public var state: State {
            if !on { return .off }
            return up ? .up : .down(detail)
        }

        public init(host: String, name: String, up: Bool, detail: String? = nil, on: Bool = true) {
            self.host = host
            self.name = name
            self.up = up
            self.detail = detail
            self.on = on
        }

        enum CodingKeys: String, CodingKey {
            case host, name, up, detail, on
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            host = try container.decode(String.self, forKey: .host)
            name = try container.decode(String.self, forKey: .name)
            up = try container.decode(Bool.self, forKey: .up)
            detail = try container.decodeIfPresent(String.self, forKey: .detail)
            on = try container.decodeIfPresent(Bool.self, forKey: .on) ?? true
        }
    }

    /// The runner's own updater: the release it runs, when it last looked for a newer one, and why that failed.
    public struct Update: Decodable, Sendable, Equatable {
        public var installed: String?
        public var lastCheck: Double?
        public var error: String?
    }

    public struct Thread: Decodable, Sendable, Equatable {
        public var host: String
        public var id: String
    }

    public struct Message: Decodable, Sendable, Equatable, Identifiable {
        public var id: String
        public var state: String
        public var detail: String?
        public var at: Double?
        public var posted: Bool
    }

    public struct Chat: Decodable, Sendable, Equatable, Identifiable {
        public var chat: String
        public var app: String?
        public var login: String?
        public var title: String?
        public var host: String?
        public var thread: Thread?
        public var worktree: String?
        public var removed: Bool
        public var working: Bool
        public var activity: String?
        public var lastActivity: Double?
        public var messages: [Message]
        public var id: String { chat }

        /// The title, or the chat's id for a chat started before titles were kept.
        public var name: String {
            if let title, !title.isEmpty { return title }
            return chat
        }

        /// The newest message's state, which the list shows.
        public var state: String? { messages.last?.state }

        /// `<chat>/<message>`: a message's id across chats, as a dismissed failure is kept.
        public func key(_ message: Message) -> String {
            "\(chat)/\(message.id)"
        }
    }

    public var version: Int
    public var writtenAt: Double
    public var pid: Int?
    public var startedAt: Double?
    public var stopping: Bool?
    public var lastFullTick: Tick?
    public var lastFastTick: Tick?
    public var longPoll: LongPoll?
    public var poll: Poll?
    /// In the order a new chat tries them.
    public var builders: [Builder]
    /// Why the runner ignored builders.json, when it did.
    public var buildersConfigError: String?
    public var update: Update?
    public var chats: [Chat]

    public static func decode(_ data: Data) throws -> RunnerStatus {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(RunnerStatus.self, from: data)
    }

    /// One app's chats, as the menu lists them.
    public struct AppGroup: Sendable, Equatable, Identifiable {
        public var app: String
        public var chats: [Chat]
        public var id: String { app }
    }

    /// Chats to show: every one not tidied away, and a tidied one with a message in the last day; grouped by app.
    public func chatsByApp(now: Double) -> [AppGroup] {
        let shown = chats.filter { chat in
            !chat.removed || chat.messages.contains { ($0.at ?? 0) > now - 86_400 }
        }
        var order: [String] = []
        var groups: [String: [Chat]] = [:]
        for chat in shown {
            let app = chat.app ?? "unknown"
            if groups[app] == nil { order.append(app) }
            groups[app, default: []].append(chat)
        }
        return order.map { AppGroup(app: $0, chats: groups[$0] ?? []) }
    }
}
