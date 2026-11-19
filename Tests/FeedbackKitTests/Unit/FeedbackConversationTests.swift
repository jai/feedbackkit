@testable import FeedbackKit
import Foundation
import Testing

@MainActor
struct FeedbackConversationTests {
    private let thread = FeedbackAgentThread(host: "builder", id: "codex:session-1")
    private let route = FeedbackRoute.thread("sesn_1")

    @Test func listRowsDecodeTheirCodingThreadAndOlderWorkersWithoutOne() throws {
        let old = Data(#"{"id":"fb_1","title":"Old feedback","createdAt":"2026-11-15T00:00:00Z"}"#.utf8)
        #expect(try JSONDecoder().decode(FeedbackThread.self, from: old).thread == nil)
        let current = Data(#"{"id":"fb_1","title":"Feedback","createdAt":"2026-11-15T00:00:00Z","thread":{"host":"builder","id":"codex:session-1"}}"#.utf8)
        #expect(try JSONDecoder().decode(FeedbackThread.self, from: current).thread == thread)
    }

    @Test func unnamedListThreadMetadataKeepsTheSharedDefaultRow() throws {
        for reference in [#"{"host":" ","id":"session"}"#, #"{"host":"builder","id":""}"#] {
            let data = Data((#"{"id":"fb_1","title":"Feedback","createdAt":"2026-11-15","thread":"#
                    + reference + "}").utf8)
            #expect(try JSONDecoder().decode(FeedbackThread.self, from: data).thread == nil)
        }
    }

    @Test func feedbackMapsItsDeliveryStatesToSharedReplyStates() {
        #expect(FeedbackMessageDelivery.pending.replyState == .pending())
        #expect(FeedbackMessageDelivery.delivering.replyState == .delivering)
        #expect(FeedbackMessageDelivery.delivered.replyState == .delivered)
        #expect(FeedbackMessageDelivery.failed.replyState == .failed)
        #expect(FeedbackMessageDelivery.unknown.replyState == .other)
    }

    @Test func deliveryMetadataKeepsUnknownUserMessagesAndIgnoresAgentMessages() throws {
        let json = #"{"id":"sesn_1","isWorking":false,"builderOnline":true,"messages":["#
            + #"{"id":"one","role":"you","text":"First","status":"delivered"},"#
            + #"{"id":"two","role":"you","text":"Second","status":"queued"},"#
            + #"{"id":"three","role":"you","text":"Third"},"#
            + #"{"id":"answer","role":"agent","text":"Working"}]}"#
        let chat = try JSONDecoder().decode(FeedbackChat.self, from: Data(json.utf8))

        #expect(chat.delivery == ["one": .delivered, "two": .unknown, "three": .unknown])
        #expect(chat.hasUndeliveredMessages)
    }

    @Test func hostedDiscoveryContinuesAfterTheAgentBecomesIdleOrAReadFails() {
        var chat = FeedbackChat(
            id: "sesn_1", messages: [], isWorking: false, activity: nil, problem: nil,
            costCents: nil, builderOnline: true
        )
        #expect(!FeedbackFollowMode.whileWorking.keepsReading(chat))
        #expect(FeedbackFollowMode.untilHandoff.keepsReading(chat))
        #expect(FeedbackFollowMode.untilHandoff.keepsReading(nil))
        chat.isWorking = true
        #expect(FeedbackFollowMode.whileWorking.keepsReading(chat))
    }
}
