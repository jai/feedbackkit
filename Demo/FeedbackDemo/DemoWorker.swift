import FeedbackKit
import Foundation

/// A FeedbackKit Worker in the app's own process: the `/feedback` routes over the role's samples, and a mock agent
/// that takes each message through the runner's states (pending, delivering, delivered) and answers a few seconds
/// later. Nothing leaves the device. `FeedbackClient(connection:)` uses it as it would the real Worker, polling included.
actor DemoWorker: FeedbackConnection {
    private let script: DemoScript
    private var list: FeedbackList
    private var chats: [String: FeedbackChat]
    /// The next build, pull request or issue number the agent answers with.
    private var number: Int
    /// How long each of the agent's steps takes.
    private let step: Duration

    init(role: DemoRole, step: Duration = .seconds(1.2)) {
        let samples = role.samples()
        script = role.script
        list = samples.list
        chats = Dictionary(uniqueKeysWithValues: samples.list.threads.map { ($0.id, samples.chat($0.id)) })
        number = role == .everyone ? 213 : 58
        self.step = step
    }

    func read<Answer: Decodable & Sendable>(_ path: String, as type: Answer.Type) async throws -> Answer {
        try await Task.sleep(for: .milliseconds(150))
        switch Route(path) {
        case .list:
            return try cast(list)
        case .chat(let id):
            return try cast(try chat(id))
        }
    }

    func send<Body: Encodable & Sendable, Answer: Decodable & Sendable>(
        _ path: String, _ body: Body, as type: Answer.Type
    ) async throws -> Answer {
        // `-DemoSlowSend`: a send that takes seconds, so a UI test sees a message while it is still on its way. Ten,
        // so a slow CI simulator still finds it, screenshots it and taps it before the send lands.
        let slow = ProcessInfo.processInfo.arguments.contains("-DemoSlowSend")
        try await Task.sleep(for: slow ? .seconds(10) : .milliseconds(300))
        let message = try JSONDecoder().decode(Sent.self, from: JSONEncoder().encode(body))
        let id: String
        switch Route(path) {
        case .list:
            id = "demo-\(UUID().uuidString.prefix(8).lowercased())"
            let title = message.text.split(separator: "\n").first.map(String.init) ?? "Screenshot"
            list.threads.insert(FeedbackThread(id: id, title: title, createdAt: Date.now.ISO8601Format()), at: 0)
            chats[id] = FeedbackChat(
                id: id, messages: [], isWorking: false, activity: nil, problem: nil,
                costCents: script.isIssue ? nil : 0, builderOnline: true
            )
        case .chat(let thread):
            _ = try chat(thread)
            id = thread
        }
        let isFirst = chats[id]?.messages.isEmpty ?? true
        let sent = add("you", message.text, to: id)
        update(id) { chat in
            chat.problem = nil
            chat.isWorking = true
            if message.images > 0 {
                chat.screenshots[sent] = message.images
            }
            // An issue Worker posts it at once; the agent's queue waits for the builder Mac to claim it.
            chat.delivery[sent] = script.isIssue ? .delivered : .pending
            chat.activity = script.isIssue ? script.steps.first : "Waiting for the builder Mac"
        }
        let answered = chats[id]
        Task { await work(on: id, message: sent, isFirst: isFirst) }
        return try cast(answered)
    }

    /// The runner claims the message, delivers it, and the agent works through its steps, then answers.
    private func work(on id: String, message: String, isFirst: Bool) async {
        if !script.isIssue {
            try? await Task.sleep(for: step * 0.6)
            update(id) { $0.delivery[message] = .delivering }
            try? await Task.sleep(for: step * 0.6)
            update(id) { $0.delivery[message] = .delivered }
        }
        // `-DemoHostedChat`: a runner that takes minutes to answer, so a UI test meets the chat before it does.
        if ProcessInfo.processInfo.arguments.contains("-DemoHostedChat") {
            return
        }
        for activity in script.steps {
            update(id) { $0.activity = activity }
            try? await Task.sleep(for: step)
        }
        let answer = (isFirst ? script.answer : script.followUp).replacing("{n}", with: "\(number)")
        if isFirst {
            number += 1
        }
        _ = add("agent", answer, to: id)
        update(id) { chat in
            chat.isWorking = false
            chat.activity = nil
            if !script.isIssue {
                chat.costCents = (chat.costCents ?? 0) + Int.random(in: 20...60)
            }
        }
    }

    private func chat(_ id: String) throws -> FeedbackChat {
        guard let chat = chats[id] else {
            throw DemoWorkerError.notFound
        }
        return chat
    }

    private func add(_ role: String, _ text: String, to id: String) -> String {
        let messageID = "m\((chats[id]?.messages.count ?? 0) + 1)"
        update(id) { $0.messages.append(.init(id: messageID, role: role, text: text)) }
        return messageID
    }

    private func update(_ id: String, _ change: (inout FeedbackChat) -> Void) {
        guard var chat = chats[id] else {
            return
        }
        change(&chat)
        chats[id] = chat
    }

    private func cast<Value, Answer>(_ value: Value) throws -> Answer {
        guard let answer = value as? Answer else {
            throw DemoWorkerError.unexpectedAnswer
        }
        return answer
    }

    private enum Route {
        case list
        case chat(String)

        init(_ path: String) {
            let parts = path.split(separator: "/")
            self = parts.count > 1 ? .chat(String(parts[1])) : .list
        }
    }

    /// What FeedbackKit posts: the words and how many screenshots (`api.md`).
    private struct Sent: Decodable {
        var text: String
        var images: Int

        private enum CodingKeys: String, CodingKey { case text, images }

        private struct Image: Decodable {}

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            text = try container.decode(String.self, forKey: .text)
            images = try container.decodeIfPresent([Image].self, forKey: .images)?.count ?? 0
        }
    }
}

enum DemoWorkerError: LocalizedError {
    case notFound
    case unexpectedAnswer

    var errorDescription: String? {
        switch self {
        case .notFound: "No such feedback."
        case .unexpectedAnswer: "The demo Worker has no answer of that shape."
        }
    }
}
