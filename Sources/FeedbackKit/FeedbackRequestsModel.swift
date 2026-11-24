import AgentChatKit
import AgentChatLive
import Foundation
import Observation
import SwiftUI

/// Words on their way, shown as sent until the chat has them, with their screenshots as thumbnails.
struct PendingMessage: Equatable, Sendable {
    var text: String
    var screenshots: Int
    var clientRef: String? = nil
    /// The screenshots' JPEGs, shown in the message while it sends.
    var images: [Data] = []
}

/// A conversation open on the screen: one started here and not sent yet (or just sent), or one in the list. A new one
/// keeps its route after its first message makes it a thread, so it goes on in place.
enum FeedbackRoute: Hashable, Sendable {
    case new(UUID)
    case thread(String)

    /// Its draft, screenshots and words on their way.
    var box: String {
        switch self {
        case .new(let id): "new-\(id.uuidString)"
        case .thread(let id): id
        }
    }
}

/// A standalone chat stops when the agent is idle; a host keeps discovering its thread until the view hands off.
enum FeedbackFollowMode {
    case whileWorking
    case untilHandoff

    func keepsReading(_ chat: FeedbackChat?) -> Bool {
        switch self {
        case .whileWorking: chat?.isWorking == true
        case .untilHandoff: true
        }
    }
}

/// Requests for changes to the app, each a conversation with an agent that makes the change, tests it and ships a
/// build. Keep one for the app's life, so drafts and open chats outlive the screen.
@MainActor
@Observable
public final class FeedbackRequestsModel {
    static let pollInterval: Duration = .seconds(3)
    /// A legacy chat's read while its agent is idle: a host that waits for its handoff reads on until it comes, but
    /// slower, for the battery (#12).
    static let idlePollInterval: Duration = .seconds(15)

    /// How long until a legacy chat is read again: soon while its agent works or a message of the sender's is on its
    /// way, else slower.
    static func pollDelay(working: Bool) -> Duration { working ? pollInterval : idlePollInterval }

    var list = FeedbackList(threads: [], builderOnline: false)
    /// The list has been read since launch. Until then it is what the device kept, or nothing: whether the builder is
    /// taking work is not known yet, so the list does not say it is offline.
    var hasReadList = false
    @ObservationIgnored let keep: FeedbackKeep?
    /// The write of the list just read, for a test to wait on.
    @ObservationIgnored var keeping: Task<Void, Never>?
    private(set) var chats: [String: FeedbackChat] = [:]
    var error: String?
    /// Unsent words, one box per conversation (`FeedbackRoute.box`).
    var drafts: [String: String] = [:]
    /// The words on their way, by box, shown as sent until the chat has them.
    private(set) var pending: [String: PendingMessage] = [:]
    /// The thread each new conversation became with its first message.
    private(set) var started: [UUID: String] = [:]
    /// The screenshots in each box, kept with its draft.
    @ObservationIgnored private var attachmentBoxes: [String: ComposerAttachments] = [:]
    /// Which boxes are sending.
    private(set) var sending: Set<String> = []
    /// The boxes the sample screenshot went into once.
    @ObservationIgnored private var seeded: Set<String> = []
    let client: FeedbackClient
    /// Cached state, not a second stream-fed transcript. REST chats are bootstrap/legacy snapshots only.
    private(set) var liveChats: [String: LiveChatModel] = [:]
    private(set) var liveControls: [String: LiveChatControls] = [:]
    @ObservationIgnored var followers: [String: (id: UUID, task: Task<Void, Never>)] = [:]
    /// What reads the list and when, beside the screen's own reads (FeedbackListReads.swift).
    @ObservationIgnored var listReads = ListReads()
    @ObservationIgnored private var bootstrapped: Set<String> = []
    @ObservationIgnored private var attempted: [String: FeedbackMessage] = [:]

    func live(for route: FeedbackRoute) -> LiveChatModel? { thread(for: route).flatMap { liveChats[$0] } }
    func controls(for route: FeedbackRoute) -> LiveChatControls? { thread(for: route).flatMap { liveControls[$0] } }

    /// A fresh projection on read, never saved back into `chats` by the stream.
    func chat(for route: FeedbackRoute) -> FeedbackChat? {
        guard let id = thread(for: route) else { return nil }
        guard let live = liveChats[id], live.chat.cursor != nil || live.chat.state != nil else { return chats[id] }
        return FeedbackChat(live: live.chat, id: id, bootstrap: chats[id])
    }

    /// The chats archived on this device (#14): out of the list until unarchived. Nothing changes on the Worker.
    private(set) var archived: Set<String>
    @ObservationIgnored private let defaults: UserDefaults?
    @ObservationIgnored private let build: String?
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let wait: @Sendable (Duration) async throws -> Void
    static let archivedKey = "FeedbackKit.archivedThreads"

    public convenience init(client: FeedbackClient) {
        self.init(client: client, keep: .standard())
    }

    /// `keep` is where the list waits for the next launch; nil keeps nothing. A host with more than one account gives
    /// each its own (`FeedbackKeep.standard(named:)`).
    public convenience init(client: FeedbackClient, keep: FeedbackKeep?) {
        self.init(client: client, defaults: .standard,
                  build: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
                  keep: client.samples == nil ? keep : nil)
    }

    init(
        client: FeedbackClient, defaults: UserDefaults?, build: String? = nil, keep: FeedbackKeep? = nil,
        now: @escaping @Sendable () -> Date = Date.init,
        wait: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.client = client
        self.defaults = defaults
        self.build = build
        self.now = now
        self.wait = wait
        self.keep = keep
        archived = Set(defaults?.stringArray(forKey: Self.archivedKey) ?? [])
        // The requests it last had, on screen at once; `refresh` reads again behind them.
        if let kept = keep?.list() {
            list = kept
        }
    }

    func draft(for box: String) -> String { drafts[box] ?? "" }

    func isSending(_ box: String) -> Bool { sending.contains(box) }

    /// The thread a conversation is, once it is one.
    func thread(for route: FeedbackRoute) -> String? {
        switch route {
        case .new(let id): started[id]
        case .thread(let id): id
        }
    }

    /// Native selection may echo the same thread after a refresh. Keep its starting route and draft box then.
    func route(for selection: String?, keeping current: FeedbackRoute?) -> FeedbackRoute? {
        if current.flatMap(thread(for:)) == selection { return current }
        return selection.map(FeedbackRoute.thread)
    }

    /// Where a requested chat shows: alone over the list in the narrow layout, picked in the wide one. A conversation
    /// started here that became that chat keeps its route, and so its draft.
    func open(
        _ request: FeedbackOpenRequest, stacked path: [FeedbackRoute], selected: FeedbackRoute?
    ) -> (path: [FeedbackRoute], selection: FeedbackRoute?) {
        let stacked = route(for: request.chat, keeping: path.last) ?? .thread(request.chat)
        return ([stacked], route(for: request.chat, keeping: selected))
    }

    func compose(reusing route: FeedbackRoute?) -> FeedbackRoute {
        if case .new(let id) = route, started[id] == nil {
            return .new(id)
        }
        return .new(UUID())
    }

    /// Its title: the list's, else the first words sent, else nothing yet.
    func title(for route: FeedbackRoute) -> String? {
        guard let id = thread(for: route) else {
            return nil
        }
        return list.threads.first { $0.id == id }?.title
            ?? chats[id]?.messages.first { $0.isJai }?.text
            ?? pending[route.box]?.text
    }

    func attachments(for box: String) -> ComposerAttachments {
        if let attachments = attachmentBoxes[box] {
            return attachments
        }
        let attachments = ComposerAttachments()
        attachmentBoxes[box] = attachments
        return attachments
    }

    func binding(for box: String) -> Binding<String> {
        Binding(get: { self.drafts[box] ?? "" }, set: { self.drafts[box] = $0.isEmpty ? nil : $0 })
    }

    /// The conversation's draft, to its thread, or as a new request before it has one: that makes the thread.
    func send(_ route: FeedbackRoute) async {
        let box = route.box
        let thread = thread(for: route)
        let text = draft(for: box).trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = attachments(for: box)
        guard !text.isEmpty || !attachments.isEmpty, !sending.contains(box) else {
            return
        }
        sending.insert(box)
        error = nil
        let screenshots = attachments.take()
        pending[box] = PendingMessage(text: text, screenshots: screenshots.count, images: screenshots.map(\.jpeg))
        drafts[box] = nil
        defer {
            sending.remove(box)
            pending[box] = nil
        }
        do {
            let images = screenshots.map { MessageImage(jpeg: $0.jpeg) }
            let previous = attempted[box]
            let message = FeedbackMessage(
                text: text, build: previous?.build ?? build, images: images,
                client_ref: previous.flatMap { $0.text == text && $0.images == images ? $0.client_ref : nil }
                    ?? UUID().uuidString
            )
            attempted[box] = message
            pending[box]?.clientRef = message.client_ref
            if let samples = client.samples {
                try await sendSample(message, thread: thread, route: route, answer: samples.answer)
                attempted[box] = nil
                thread.map(answered)
                return
            }
            let chat = try await client.send(message, to: thread)
            // Once ACP has a snapshot, REST writes must not replace the visible transcript.
            if liveChats[chat.id]?.chat.cursor == nil { chats[chat.id] = chat }
            attempted[box] = nil
            if case .new(let id) = route, thread == nil {
                started[id] = chat.id
                await refresh()
            } else {
                answered(chat.id)
            }
        } catch {
            drafts[box] = text
            attachments.restore(screenshots)
            self.error = client.direct == nil ? error.localizedDescription : "Could not send feedback. Try again."
        }
    }

    /// Direct/v2 follows ACP while visible, including idle; legacy connections keep their original read behavior.
    func follow(
        _ route: FeedbackRoute, mode: FeedbackFollowMode = .whileWorking,
        isForeground: Bool = true, isHosted: Bool = false
    ) async {
        guard let thread = thread(for: route) else {
            return
        }
        if let direct = client.direct {
            await followLive(thread, configuration: direct, active: isForeground && !isHosted)
            return
        }
        guard isForeground, !isHosted else { return }
        if let samples = client.samples {
            if chats[thread] == nil {
                chats[thread] = samples.chat(thread)
            }
            return
        }
        while !Task.isCancelled {
            do {
                let chat = try await client.chat(thread)
                chats[thread] = chat
                error = nil
                chatShows(thread, messages: chat.messages.count, isWorking: chat.isWorking)
            } catch {
                self.error = error.localizedDescription
            }
            guard mode.keepsReading(chats[thread]) || sending.contains(route.box) else {
                return
            }
            try? await wait(Self.pollDelay(
                working: chats[thread]?.isWorking == true || sending.contains(route.box)
            ))
        }
    }

    private func followLive(_ thread: String, configuration: FeedbackDirect, active: Bool) async {
        let previous = followers[thread]?.task
        previous?.cancel()
        guard active else { return }
        guard configuration.baseURL.scheme?.lowercased() == "https" else {
            error = "Direct feedback requires an HTTPS Worker root."
            return
        }
        let id = UUID()
        let live: LiveChatModel
        if let cached = liveChats[thread] { live = cached }
        else {
            live = configuration.makeLive(thread)
            liveChats[thread] = live
            liveControls[thread] = LiveChatControls(live: live)
        }
        // Follow inline through completion, rather than awaiting a reader inside a cancellation handler:
        // that awaited-reader pattern aborts on the macOS 26 runtime (AgentChatKit a834e3a).
        let (completion, finished) = AsyncStream<Void>.makeStream()
        let task = Task { @MainActor in
            defer { finished.finish() }
            await previous?.value
            guard !Task.isCancelled else { return }
            // One metadata bootstrap; failures do not turn into a REST refresh loop.
            if self.chats[thread] == nil, self.bootstrapped.insert(thread).inserted {
                if let snapshot = try? await self.client.chat(thread) { self.chats[thread] = snapshot }
            }
            guard !Task.isCancelled else { return }
            await live.follow()
        }
        finished.onTermination = { _ in task.cancel() }
        followers[thread] = (id, task)
        watch(live, thread: thread, follower: id)
        for await _ in completion {}
        await task.value
        if followers[thread]?.id == id { followers[thread] = nil }
    }

    /// `FeedbackSamples.screenshot`: a box starts with it in its tray, once.
    func seedScreenshot(in box: String) async {
        guard let screenshot = client.samples?.screenshot else {
            return
        }
        let attachments = attachments(for: box)
        if attachments.isEmpty, !seeded.contains(box) {
            seeded.insert(box)
            await attachments.add(screenshot)
        }
    }
}

extension FeedbackRequestsModel {
    /// `FeedbackSamples`: a send the agent answers a moment later, so a test and a recording see the whole round.
    private func sendSample(_ message: FeedbackMessage, thread: String?, route: FeedbackRoute, answer: String)
        async throws {
        try await wait(.milliseconds(600))
        let id = thread ?? "sesn_new_\(list.threads.count)"
        var chat = chats[id] ?? FeedbackChat(
            id: id, messages: [], isWorking: false, activity: nil, problem: nil, costCents: 0, builderOnline: true
        )
        let sent = "\(chat.messages.count + 1)"
        chat.messages.append(.init(id: sent, role: "you", text: message.text, anchor: nil))
        if !message.images.isEmpty {
            chat.screenshots[sent] = message.images.count
        }
        chat.isWorking = true
        chat.activity = "Reading the app"
        chats[id] = chat
        if case .new(let started) = route, thread == nil {
            self.started[started] = id
            list.threads.insert(FeedbackThread(id: id, title: message.text, createdAt: now().ISO8601Format()), at: 0)
        }
        Task {
            try? await wait(.seconds(3))
            guard var chat = chats[id] else {
                return
            }
            chat.messages.append(.init(id: "\(chat.messages.count + 1)", role: "agent", text: answer, anchor: nil))
            chat.isWorking = false
            chat.activity = nil
            chats[id] = chat
        }
    }
}

/// Archive on this device (#14).
extension FeedbackRequestsModel {
    /// The list's chats less the archived ones, newest first.
    var visibleThreads: [FeedbackThread] { list.threads.filter { !archived.contains($0.id) } }
    /// The archived chats the list still has, newest first.
    var archivedThreads: [FeedbackThread] { list.threads.filter { archived.contains($0.id) } }

    func archive(_ thread: String) { setArchived(archived.union([thread])) }

    func unarchive(_ thread: String) { setArchived(archived.subtracting([thread])) }

    private func setArchived(_ threads: Set<String>) {
        archived = threads
        defaults?.set(threads.sorted(), forKey: Self.archivedKey)
    }
}
