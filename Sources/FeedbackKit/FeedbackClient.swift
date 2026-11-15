import AgentChatCore
import Foundation

/// One feature request, as the Worker lists it (`worker/src/feedback.ts` in Agent Pager's pr-worker).
public struct FeedbackThread: Decodable, Equatable, Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let createdAt: String
    /// The coding thread behind this feedback, when the runner has started it. Hosts can show their live row data.
    public let thread: FeedbackAgentThread?
    /// Where its agent stands, for the row; nil from a Worker before this was served, and for issue chats.
    public let agent: FeedbackThreadAgent?
    /// What its feedback shipped, for the row's accessories; nil until the runner found any.
    public let shipped: FeedbackShipped?

    public init(
        id: String, title: String, createdAt: String, thread: FeedbackAgentThread? = nil, agent: FeedbackThreadAgent? = nil,
        shipped: FeedbackShipped? = nil
    ) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.thread = thread
        self.agent = agent
        self.shipped = shipped
    }

    private enum CodingKeys: String, CodingKey { case id, title, createdAt, thread, agent, shipped }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        thread = try FeedbackAgentThread.decodeNamed(container, forKey: .thread)
        agent = try? container.decodeIfPresent(FeedbackThreadAgent.self, forKey: .agent)
        shipped = FeedbackShipped.decodeLenient(container, forKey: .shipped)
    }
}

/// A feedback chat's agent on the list: working (and at what), waiting on the sender, or idle.
public struct FeedbackThreadAgent: Decodable, Equatable, Hashable, Sendable {
    public enum State: String, Decodable, Sendable {
        case working
        case needsYou = "needs_you"
        case idle
    }

    public let state: State
    public let activity: String?

    public init(state: State, activity: String? = nil) {
        self.state = state
        self.activity = activity
    }
}

/// The requests and whether the builder Mac is taking work.
public struct FeedbackList: Decodable, Equatable, Sendable {
    public var threads: [FeedbackThread]
    public var builderOnline: Bool
    /// What sending does, when the Worker says (an issue Worker: a public GitHub issue); nil is the coding agent.
    public var notice: String?

    public init(threads: [FeedbackThread], builderOnline: Bool, notice: String? = nil) {
        self.threads = threads
        self.builderOnline = builderOnline
        self.notice = notice
    }
}

/// The coding thread the feedback agent runs in, once the runner has started it.
public struct FeedbackAgentThread: Codable, Equatable, Hashable, Sendable {
    public let host: String
    public let id: String

    public init(host: String, id: String) {
        self.host = host
        self.id = id
    }
}

extension FeedbackAgentThread {
    /// Both response boundaries share the same metadata rule; unnamed references keep the default Feedback row/chat.
    static func decodeNamed<Key: CodingKey>(
        _ container: KeyedDecodingContainer<Key>, forKey key: Key
    ) throws -> Self? {
        guard let thread = try container.decodeIfPresent(Self.self, forKey: key),
              !thread.host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !thread.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return thread
    }
}

/// What the feedback runner knows of a message. Missing or newer states stay unknown until it confirms delivery.
public enum FeedbackMessageDelivery: Equatable, Sendable, Decodable {
    case pending
    case delivering
    case delivered
    case failed
    case unknown

    public init(from decoder: any Decoder) throws {
        self = switch try decoder.singleValueContainer().decode(String.self) {
        case "pending": .pending
        case "delivering": .delivering
        case "delivered": .delivered
        case "failed": .failed
        default: .unknown
        }
    }
}

/// One request's conversation with the builder agent: the Ask chat's shape, and whether the builder Mac is taking work.
public struct FeedbackChat: Decodable, Equatable, Sendable {
    /// One line of the conversation: the sender's (`you`) or the agent's.
    public struct Message: Decodable, Equatable, Identifiable, Sendable {
        public let id: String
        public let role: String
        public let text: String
        public let anchor: String?

        public init(id: String, role: String, text: String, anchor: String? = nil) {
            self.id = id
            self.role = role
            self.text = text
            self.anchor = anchor
        }

        /// The sender's own.
        public var isJai: Bool { role == "you" }
    }

    public var id: String
    public var messages: [Message]
    public var isWorking: Bool
    public var activity: String?
    public var problem: String?
    public var costCents: Int?
    public var builderOnline: Bool
    /// The agent's coding thread. A host with its own thread conversation can use that same reply path here.
    public var thread: FeedbackAgentThread?
    /// How many screenshots each message carried, by its id; none for a message without.
    public var screenshots: [String: Int]
    /// Only the sender's messages have delivery states; agent messages do not travel through the runner's queue.
    public var delivery: [String: FeedbackMessageDelivery]
    /// What the feedback shipped, for the chat's header; nil until the runner found any.
    public var shipped: FeedbackShipped?

    public var hasUndeliveredMessages: Bool { delivery.values.contains { $0 != .delivered } }

    public init(
        id: String, messages: [Message], isWorking: Bool, activity: String?, problem: String?,
        costCents: Int?, builderOnline: Bool, screenshots: [String: Int] = [:], thread: FeedbackAgentThread? = nil,
        delivery: [String: FeedbackMessageDelivery] = [:], shipped: FeedbackShipped? = nil
    ) {
        self.id = id
        self.messages = messages
        self.isWorking = isWorking
        self.activity = activity
        self.problem = problem
        self.costCents = costCents
        self.builderOnline = builderOnline
        self.thread = thread
        self.screenshots = screenshots
        self.delivery = delivery
        self.shipped = shipped
    }

    private enum CodingKeys: String, CodingKey {
        case id, messages, isWorking, activity, problem, costCents, builderOnline, thread, shipped
    }

    /// The screenshot count and persisted delivery state; a Worker from before either field sends none.
    private struct MessageMetadata: Decodable {
        var id: String
        var images: Int?
        var status: FeedbackMessageDelivery?
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        messages = try container.decode([Message].self, forKey: .messages)
        isWorking = try container.decode(Bool.self, forKey: .isWorking)
        activity = try container.decodeIfPresent(String.self, forKey: .activity)
        problem = try container.decodeIfPresent(String.self, forKey: .problem)
        costCents = try container.decodeIfPresent(Int.self, forKey: .costCents)
        builderOnline = try container.decode(Bool.self, forKey: .builderOnline)
        thread = try FeedbackAgentThread.decodeNamed(container, forKey: .thread)
        shipped = FeedbackShipped.decodeLenient(container, forKey: .shipped)
        let metadata = try container.decode([MessageMetadata].self, forKey: .messages)
        screenshots = Dictionary(metadata.compactMap { message in
            message.images.flatMap { $0 > 0 ? (message.id, $0) : nil }
        }, uniquingKeysWith: { first, _ in first })
        let sent = Set(messages.filter(\.isJai).map(\.id))
        delivery = Dictionary(metadata.filter { sent.contains($0.id) }.map { message in
            (message.id, message.status ?? .unknown)
        }, uniquingKeysWith: { first, _ in first })
    }
}

/// What goes to the builder: the words, the screenshots and the build the sender is on. `client_ref` makes a retry send
/// it once.
struct FeedbackMessage: Encodable, Sendable {
    let text: String
    let build: String?
    let images: [MessageImage]
    // swiftlint:disable:next identifier_name
    let client_ref: String
}

/// Made-up requests and no Worker, for UI tests and screenshots: a send is answered a moment later.
public struct FeedbackSamples: Sendable {
    public var list: FeedbackList
    /// A listed request's conversation.
    public var chat: @Sendable (String) -> FeedbackChat
    /// The agent's answer to anything sent.
    public var answer: String
    /// A picture each composer starts with in its tray; nil starts them empty.
    public var screenshot: Data?

    public init(
        list: FeedbackList, chat: @escaping @Sendable (String) -> FeedbackChat, answer: String, screenshot: Data? = nil
    ) {
        self.list = list
        self.chat = chat
        self.answer = answer
        self.screenshot = screenshot
    }
}

/// The Worker's feature-request routes. The host gives where they are and how to reach them (`FeedbackConnection`).
public struct FeedbackClient: Sendable {
    /// The routes' root on the Worker: `GET/POST feedback` and `GET/POST feedback/<id>`.
    static let root = "feedback"

    let connection: any FeedbackConnection
    public let direct: FeedbackDirect?
    /// Set: nothing leaves the device (`FeedbackSamples`).
    public let samples: FeedbackSamples?

    public init(connection: any FeedbackConnection, samples: FeedbackSamples? = nil) {
        self.connection = connection
        self.samples = samples
        self.direct = nil
    }

    /// Direct/v2 with REST creation and list, and ACP live conversations.
    public init(direct: FeedbackDirect) {
        self.direct = direct
        connection = DirectFeedbackConnection(configuration: direct)
        samples = nil
    }

    /// Straight to a Worker with `URLSession`: its root, and the bearer each request carries.
    public init(
        baseURL: @escaping @Sendable () -> URL?, bearer: @escaping @Sendable () async throws -> String,
        samples: FeedbackSamples? = nil
    ) {
        self.init(connection: URLFeedbackConnection(baseURL: baseURL, bearer: bearer), samples: samples)
    }

    func list() async throws -> FeedbackList {
        try await connection.read(Self.root, as: FeedbackList.self)
    }

    func chat(_ thread: String) async throws -> FeedbackChat {
        try await connection.read("\(Self.root)/\(thread)", as: FeedbackChat.self)
    }

    /// To the thread, or as a new request when there is none: that makes the thread.
    func send(_ message: FeedbackMessage, to thread: String?) async throws -> FeedbackChat {
        try await connection.send(thread.map { "\(Self.root)/\($0)" } ?? Self.root, message, as: FeedbackChat.self)
    }
}
