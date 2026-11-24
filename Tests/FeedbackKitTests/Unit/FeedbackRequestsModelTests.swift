@testable import FeedbackKit
import FeedbackKitTestSupport
import Foundation
import Observation
import Testing

/// The feature-request routes as the Worker answers them, and a conversation going from new to a thread.
@MainActor
struct FeedbackRequestsModelTests {
    private typealias Worker = FeedbackHTTP

    private func client(_ worker: Worker) -> FeedbackClient { worker.client }

    @Test func nativeSelectionEchoKeepsAStartedConversationsRouteAndDraft() async throws {
        let model = FeedbackRequestsModel(client: client(Worker()), defaults: nil)
        let route = model.compose(reusing: nil)
        model.binding(for: route.box).wrappedValue = "Start this feedback"
        await model.send(route)
        let id = try #require(model.thread(for: route))
        model.binding(for: route.box).wrappedValue = "Keep these follow-up words"
        let selected = try #require(model.route(for: id, keeping: route))
        #expect(selected == route)
        #expect(model.binding(for: selected.box).wrappedValue == "Keep these follow-up words")
        #expect(model.route(for: "different", keeping: route) == .thread("different"))
        #expect(model.route(for: nil, keeping: route) == nil)
        let unsent = FeedbackRoute.new(UUID())
        #expect(model.route(for: nil, keeping: unsent) == unsent)
    }

    /// Each message's screenshot count; a Worker from before them sends none.
    @Test func aChatCountsScreenshots() throws {
        let json = #"{"id": "sesn_1", "isWorking": false, "builderOnline": true, "costCents": 3, "messages": ["#
            + #"{"id": "e1", "role": "you", "text": "", "anchor": null, "images": 2},"#
            + #"{"id": "e2", "role": "agent", "text": "Done", "anchor": null}]}"#
        let chat = try JSONDecoder().decode(FeedbackChat.self, from: Data(json.utf8))
        #expect(chat.screenshots == ["e1": 2] && chat.messages.count == 2)
    }

    @Test func aChatNamesTheAgentsCodingThread() throws {
        let json = #"{"id":"sesn_1","messages":[],"isWorking":true,"builderOnline":true,"thread": "#
            + #"{"host":"builder","id":"codex:session-1"}}"#
        let chat = try JSONDecoder().decode(FeedbackChat.self, from: Data(json.utf8))

        #expect(chat.thread == FeedbackAgentThread(host: "builder", id: "codex:session-1"))
    }

    @Test func aChatWithoutAnAgentThreadKeepsTheFeedbackConversation() throws {
        for thread in ["", #", "thread": null"#] {
            let json = #"{"id":"sesn_1","messages":[],"isWorking":false,"builderOnline":true"# + thread + "}"
            let chat = try JSONDecoder().decode(FeedbackChat.self, from: Data(json.utf8))
            #expect(chat.thread == nil)
        }
    }

    @Test func aThreadMustNameBothItsHostAndSession() throws {
        let json = #"{"id":"sesn_1","messages":[],"isWorking":true,"builderOnline":true,"thread": "#
            + #"{"host":"builder"}}"#

        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(FeedbackChat.self, from: Data(json.utf8))
        }
    }

    @Test func blankThreadMetadataKeepsTheFeedbackConversation() throws {
        for thread in [#"{"host":" ","id":"codex:session-1"}"#, #"{"host":"builder","id":""}"#] {
            let json = #"{"id":"sesn_1","messages":[],"isWorking":true,"builderOnline":true,"thread": "#
                + thread + "}"
            let chat = try JSONDecoder().decode(FeedbackChat.self, from: Data(json.utf8))
            #expect(chat.thread == nil)
        }
    }

    @Test func sampleChatsCanNameAnAgentThreadAndOlderInitializersStayEmpty() {
        var chat = FeedbackChat(
            id: "sesn_1", messages: [], isWorking: false, activity: nil, problem: nil,
            costCents: nil, builderOnline: true
        )
        #expect(chat.thread == nil)
        let thread = FeedbackAgentThread(host: "builder", id: "codex:session-1")
        chat.thread = thread
        #expect(chat.thread == thread)
    }

    /// The first message of a new conversation makes the thread; the conversation keeps its route and goes on there.
    @Test func theFirstMessageMakesTheThread() async {
        let worker = Worker()
        let model = FeedbackRequestsModel(client: client(worker), defaults: nil)
        let route = model.compose(reusing: nil)
        model.drafts[route.box] = "Bigger clock"
        await model.send(route)
        #expect(model.thread(for: route) == "sesn_1")
        #expect(model.title(for: route) == "Bigger clock")
        #expect(model.compose(reusing: route) != route, "New starts afresh once the old one is a thread")
        #expect(worker.requests == ["POST /feedback", "GET /feedback"])
        model.drafts[route.box] = "And the badge"
        await model.send(route)
        #expect(worker.requests.last == "POST /feedback/sesn_1")
    }

    /// Battery (#12): a chat that is not in front of the person is never read, and an idle one is read slower.
    @Test func aChatInTheBackgroundIsNeverReadAndAnIdleOneIsReadSlower() async {
        let worker = Worker()
        let model = FeedbackRequestsModel(client: client(worker), defaults: nil)
        await model.follow(.thread("sesn_1"), mode: .untilHandoff, isForeground: false)
        await model.follow(.thread("sesn_1"), mode: .untilHandoff, isForeground: true, isHosted: true)
        #expect(worker.requests.isEmpty, "in the background, or handed to the host's own conversation: no reads")
        #expect(FeedbackRequestsModel.pollDelay(working: true) == .seconds(3))
        #expect(FeedbackRequestsModel.pollDelay(working: false) == .seconds(15))
    }

    /// Samples: nothing reaches a Worker, and the agent answers a moment after a send.

    @Test func samplesAnswerWithoutAWorker() async throws {
        let samples = FeedbackSamples(
            list: FeedbackList(threads: [], builderOnline: true),
            chat: { FeedbackChat(
                id: $0, messages: [], isWorking: false, activity: nil, problem: nil, costCents: 0, builderOnline: true
            ) },
            answer: "Got it."
        )
        let pauses = AsyncStream<AsyncStream<Void>.Continuation>.makeStream()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let worker = Worker()
        let model = FeedbackRequestsModel(
            client: FeedbackClient(connection: client(worker).connection, samples: samples), defaults: nil,
            now: { now }, wait: { _ in
                let pause = AsyncStream<Void>.makeStream()
                pauses.continuation.yield(pause.continuation)
                for await _ in pause.stream { break }
            }
        )
        let route = model.compose(reusing: nil)
        model.drafts[route.box] = "Bigger clock"
        let sending = Task { await model.send(route) }
        var waits = pauses.stream.makeAsyncIterator()
        let send = try #require(await waits.next())
        send.finish()
        await sending.value
        let thread = try #require(model.thread(for: route))
        #expect(model.chats[thread]?.isWorking == true)
        #expect(model.list.threads.first?.createdAt == now.ISO8601Format())
        let changed = AsyncStream<Void>.makeStream()
        withObservationTracking {
            _ = model.chats[thread]?.messages.last?.text
        } onChange: {
            changed.continuation.finish()
        }
        let answer = try #require(await waits.next())
        answer.finish()
        for await _ in changed.stream {}
        #expect(model.chats[thread]?.messages.last?.text == "Got it.")
        #expect(worker.requests.isEmpty)
        pauses.continuation.finish()
    }
}
