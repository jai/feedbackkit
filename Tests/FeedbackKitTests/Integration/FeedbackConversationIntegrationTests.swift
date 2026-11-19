@testable import FeedbackKit
import Foundation
import SwiftUI
import Testing

@MainActor
struct FeedbackConversationIntegrationTests {
    private let thread = FeedbackAgentThread(host: "builder", id: "codex:session-1")
    private let route = FeedbackRoute.thread("sesn_1")

    private func model(delivery: [String: FeedbackMessageDelivery] = [:]) async -> FeedbackRequestsModel {
        let thread = thread
        let samples = FeedbackSamples(
            list: FeedbackList(threads: [], builderOnline: true),
            chat: { FeedbackChat(
                id: $0, messages: [], isWorking: false, activity: nil, problem: nil,
                costCents: nil, builderOnline: true, thread: thread, delivery: delivery
            ) }, answer: "Got it."
        )
        let model = FeedbackRequestsModel(client: FeedbackClient(
            baseURL: { URL(string: "https://worker.example.com")! }, bearer: { "token" }, samples: samples
        ), defaults: nil)
        await model.follow(route)
        return model
    }

    @Test func everyUndeliveredStateKeepsTheExistingFeedbackHistory() async {
        for state in [FeedbackMessageDelivery.pending, .delivering, .failed, .unknown] {
            let model = await model(delivery: ["old-message": state])
            var called = false
            let view = FeedbackChatView(model: model, route: route, conversation: { _ in
                called = true
                return AnyView(EmptyView())
            })

            #expect(view.hostedConversation == nil)
            #expect(!called)
        }
    }

    @Test func theHostReceivesTheSameDraftBindingAndAttachmentTray() async throws {
        let model = await model(delivery: ["old-message": .delivered])
        model.drafts[route.box] = "The next change"
        let attachments = model.attachments(for: route.box)
        var received: FeedbackConversation?
        let view = FeedbackChatView(model: model, route: route, conversation: { context in
            received = context
            return AnyView(EmptyView())
        })

        #expect(view.hostedConversation != nil)
        let context = try #require(received)
        #expect(context.thread == thread)
        #expect(context.draft.wrappedValue == "The next change")
        #expect(context.attachments === attachments)
        context.draft.wrappedValue = ""
        #expect(model.draft(for: route.box).isEmpty)
    }

    @Test func theHostCanKeepFeedbackWhileItsThreadIsUnavailable() async {
        let model = await model()
        var received: FeedbackAgentThread?
        let view = FeedbackChatView(model: model, route: route, conversation: { context in
            received = context.thread
            return nil
        })

        #expect(view.hostedConversation == nil)
        #expect(received == thread)
        #expect(view.awaitsAgentThread)
    }

    @Test func anEarlierFailedMessageExplainsWhyTheChatCannotHandOff() async {
        let model = await model(delivery: ["old-message": .failed, "newer-message": .delivered])
        let view = FeedbackChatView(model: model, route: route, conversation: { _ in AnyView(EmptyView()) })

        #expect(view.hostedConversation == nil)
        #expect(view.handoffProblem == "An earlier message did not reach the agent. Start new feedback to continue.")
    }

    @Test func onlyAHostedChatThatHasStartedBlocksTheFeedbackComposer() async {
        let model = await model()
        let hosted: (FeedbackConversation) -> AnyView? = { _ in nil }
        let first = FeedbackChatView(model: model, route: .new(UUID()), conversation: hosted)
        let started = FeedbackChatView(model: model, route: route, conversation: hosted)
        let standalone = FeedbackChatView(model: model, route: route, conversation: nil)

        #expect(!first.awaitsAgentThread)
        #expect(started.awaitsAgentThread)
        #expect(!standalone.awaitsAgentThread)
        #expect(standalone.hostedConversation == nil)
    }
}
