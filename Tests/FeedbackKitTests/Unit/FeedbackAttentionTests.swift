@testable import FeedbackKit
import FeedbackKitTestSupport
import Foundation
import Synchronization
import Testing

/// How many chats need the sender, for the host's badge (Jai, 2026-11-24: "we need to expose the number of questions
/// or conversations that need attention so that the app can expose it as a badge on the tab bar"): the chats with a
/// question of their agent's still open, there before the Feedback screen is, and right after each thing that can
/// change it.
@MainActor
struct FeedbackAttentionTests {
    /// A keep in memory: a unit test touches no disk.
    private final class Memory: Sendable {
        let data = Mutex<Data?>(nil)
        var keep: FeedbackKeep {
            FeedbackKeep(
                load: { self.data.withLock { $0 } }, save: { data in self.data.withLock { $0 = data } },
                remove: { self.data.withLock { $0 = nil } }
            )
        }
    }

    private static func row(_ id: String, _ agent: String?, ended: Bool = false) -> String {
        #"{"id": "\#(id)", "title": "Chat \#(id)", "createdAt": "2026-11-05T09:00:00Z""#
            + (agent.map { #", "agent": \#($0)"# } ?? "") + (ended ? #", "ended": true"# : "") + "}"
    }

    private static func list(_ rows: String...) -> String {
        #"{"threads": [\#(rows.joined(separator: ", "))], "builderOnline": true}"#
    }

    private static let asks = #"{"state": "needs_you", "activity": null, "asks": true}"#
    private static let spokeLast = #"{"state": "needs_you", "activity": null}"#
    private static let queued = #"{"state": "working", "activity": null, "queued": true}"#
    private static let chat = #"{"id": "sesn_1", "isWorking": true, "builderOnline": true, "messages": ["#
        + #"{"id": "e1", "role": "you", "text": "The big one", "anchor": null}]}"#

    /// A chat counts while its agent's question is open: not one whose agent only spoke last, works, or is gone, and
    /// not one archived on this device.
    @Test func onlyChatsWithAnOpenQuestionCount() async {
        let worker = FeedbackHTTP(list: Self.list(
            Self.row("sesn_1", Self.asks), Self.row("sesn_2", Self.asks), Self.row("sesn_3", Self.spokeLast),
            Self.row("sesn_4", Self.queued), Self.row("sesn_5", Self.asks, ended: true),
            Self.row("sesn_6", #"{"state": "working", "activity": "Reading", "asks": true}"#), Self.row("sesn_7", nil)
        ))
        let model = FeedbackRequestsModel(client: worker.client, defaults: nil)
        #expect(model.needsAttentionCount == 0, "nothing read and nothing kept: nothing to count")

        await model.refresh()

        #expect(model.needsAttentionCount == 2)
        #expect(model.list.threads.filter(\.needsAttention).map(\.id) == ["sesn_1", "sesn_2"])
        model.archive("sesn_2")
        #expect(model.needsAttentionCount == 1, "an archived chat shows no Needs you, so it badges nothing")
        model.unarchive("sesn_2")
        #expect(model.needsAttentionCount == 2)
    }

    /// At launch the badge is what the device kept, before any read and without the Feedback screen.
    @Test func theCountIsThereFromTheKeptListBeforeAnyRead() async {
        let memory = Memory()
        memory.data.withLock { $0 = Data(Self.list(Self.row("sesn_1", Self.asks)).utf8) }
        let worker = FeedbackHTTP(list: Self.list(Self.row("sesn_1", Self.queued)))

        let model = FeedbackRequestsModel(client: worker.client, defaults: nil, keep: memory.keep)

        #expect(model.needsAttentionCount == 1 && worker.requests.isEmpty)
        await model.refresh()
        #expect(model.needsAttentionCount == 0, "the read says the question was answered elsewhere")
    }

    /// The sender's answer ends the question at once, on the device and in what it keeps, and the list is read behind
    /// it; a read that still says the old thing is not waited for.
    @Test func anAnswerClearsTheCountAtOnceAndIsKept() async throws {
        let memory = Memory()
        let worker = FeedbackHTTP(list: Self.list(Self.row("sesn_1", Self.asks)), chats: [Self.chat])
        let model = FeedbackRequestsModel(client: worker.client, defaults: nil, keep: memory.keep)
        await model.refresh()
        #expect(model.needsAttentionCount == 1)
        worker.lists(Self.list(Self.row("sesn_1", Self.queued)))

        model.drafts["sesn_1"] = "The big one"
        await model.send(.thread("sesn_1"))

        #expect(model.needsAttentionCount == 0)
        #expect(worker.requests == ["GET /feedback", "POST /feedback/sesn_1"], "counted before the list is read again")
        await model.keeping?.value
        let relaunched = FeedbackRequestsModel(client: worker.client, defaults: nil, keep: memory.keep)
        #expect(relaunched.needsAttentionCount == 0, "the next launch does not badge an answered question")
        await model.listReads.task?.value
        #expect(worker.requests.last == "GET /feedback" && model.needsAttentionCount == 0)
        #expect(model.list.threads.first?.agent?.isQueued == true)
    }

    /// A reply to a chat with no open question changes no row and reads no list.
    @Test func aReplyToAChatWithoutAQuestionReadsNoList() async {
        let worker = FeedbackHTTP(list: Self.list(Self.row("sesn_1", Self.spokeLast)), chats: [Self.chat])
        let model = FeedbackRequestsModel(client: worker.client, defaults: nil)
        await model.refresh()

        model.drafts["sesn_1"] = "Thanks"
        await model.send(.thread("sesn_1"))

        #expect(model.listReads.task == nil && worker.requests == ["GET /feedback", "POST /feedback/sesn_1"])
    }

    /// A question's push counts before the list answers, and with no network at all; then the list is read.
    @Test func aQuestionsPushCountsAtOnceAndReadsTheList() async {
        let worker = FeedbackHTTP(list: Self.list(Self.row("sesn_1", Self.queued), Self.row("sesn_2", Self.queued)))
        let model = FeedbackRequestsModel(client: worker.client, defaults: nil)
        await model.refresh()
        #expect(model.needsAttentionCount == 0)

        worker.lists(nil, status: 503)
        await model.received(FeedbackPush(chat: "sesn_1", kind: .reply, asks: true))
        #expect(model.needsAttentionCount == 1, "the push itself says the chat asks")
        #expect(worker.requests == ["GET /feedback", "GET /feedback"])

        worker.lists(Self.list(Self.row("sesn_1", Self.asks), Self.row("sesn_2", Self.asks)))
        await model.received(FeedbackPush(chat: "sesn_2", kind: .reply))
        #expect(model.needsAttentionCount == 2, "any reply's push reads the list, which says what asks")
    }

    /// A silent delivery push is no news of a question.
    @Test func aDeliveryPushReadsNothing() async {
        let worker = FeedbackHTTP()
        let model = FeedbackRequestsModel(client: worker.client, defaults: nil)

        await model.received(FeedbackPush(chat: "sesn_1", kind: .status))

        #expect(worker.requests.isEmpty)
    }

    /// An open chat that gains the agent's message, or whose agent stops, reads the list: its row and the count
    /// follow it without a pull. A chat read again unchanged reads nothing more.
    @Test func anOpenChatThatChangesReadsTheListOnce() async {
        let asked = #"{"id": "sesn_1", "isWorking": false, "builderOnline": true, "messages": ["#
            + #"{"id": "e1", "role": "you", "text": "Bigger clock", "anchor": null},"#
            + #"{"id": "a1", "role": "agent", "text": "Which clock?", "anchor": null}]}"#
        let worker = FeedbackHTTP(list: Self.list(Self.row("sesn_1", Self.asks)), chats: [Self.chat, Self.chat, asked])
        let model = FeedbackRequestsModel(client: worker.client, defaults: nil, wait: { _ in })

        await model.follow(.thread("sesn_1"))
        await model.listReads.task?.value

        #expect(worker.requests == [
            "GET /feedback/sesn_1", "GET /feedback/sesn_1", "GET /feedback/sesn_1", "GET /feedback",
        ])
        #expect(model.needsAttentionCount == 1)
    }

    /// The row a question's push or an answer changes is written as the Worker would list it.
    @Test func aRowChangedOnTheDeviceReadsAsTheWorkersOwn() throws {
        let row = try JSONDecoder().decode(FeedbackThread.self, from: Data(Self.row("sesn_1", Self.queued).utf8))

        #expect(row.asked().agent == FeedbackThreadAgent(state: .needsYou, activity: nil, isQueued: false, asks: true))
        #expect(row.asked().needsAttention && !row.asked().answered().needsAttention)
        #expect(FeedbackStatus(agent: row.asked().answered().agent, shipped: nil) == .queued)
    }
}
