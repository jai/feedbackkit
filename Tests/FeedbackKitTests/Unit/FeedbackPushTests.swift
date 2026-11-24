@testable import FeedbackKit
import FeedbackKitTestSupport
import Foundation
import Testing

/// A push as FeedbackKit's Worker sends it (worker/src/push.ts), and the chat a tap on it opens.
@MainActor
struct FeedbackPushTests {
    @Test func aReplyPushNamesItsChatAndWhetherItAsks() {
        let reply: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Bigger clock", "body": "Done."]],
            "feedbackkit": ["chat": "fb_0123456789abcdef", "app": "agent-pager", "kind": "reply"],
        ]
        #expect(FeedbackPush(userInfo: reply) == FeedbackPush(
            chat: "fb_0123456789abcdef", app: "agent-pager", kind: .reply, asks: false
        ))
        let question: [AnyHashable: Any] = [
            "feedbackkit": ["chat": "fb_0123456789abcdef", "app": "agent-pager", "kind": "reply", "asks": true],
        ]
        #expect(FeedbackPush(userInfo: question)?.asks == true)
        let status: [AnyHashable: Any] = ["feedbackkit": ["chat": "fb_1", "kind": "status", "status": "delivered"]]
        #expect(FeedbackPush(userInfo: status)?.kind == .status)
        // A kind from a newer Worker is still about its chat.
        #expect(FeedbackPush(userInfo: ["feedbackkit": ["chat": "fb_1", "kind": "shipped"]])
            == FeedbackPush(chat: "fb_1", app: nil, kind: nil, asks: false))
    }

    @Test func anotherAppsNotificationOrAnUnusableChatIsNoFeedbackPush() {
        #expect(FeedbackPush(userInfo: ["kind": "thread_waiting", "thread_id": "t1"]) == nil)
        #expect(FeedbackPush(userInfo: ["feedbackkit": "fb_1"]) == nil)
        #expect(FeedbackPush(userInfo: ["feedbackkit": ["kind": "reply"]]) == nil)
        #expect(FeedbackPush(userInfo: ["feedbackkit": ["chat": ""]]) == nil)
        #expect(FeedbackPush(userInfo: ["feedbackkit": ["chat": "../feedback?x=1"]]) == nil)
        #expect(FeedbackPush(userInfo: ["feedbackkit": ["chat": String(repeating: "a", count: 201)]]) == nil)
    }

    @Test func aRequestedChatOpensAloneOverTheListWhateverWasOpen() {
        let model = FeedbackRequestsModel(client: FeedbackHTTP().client, defaults: nil)
        let request = FeedbackOpenRequest(chat: "fb_2")
        let fromList = model.open(request, stacked: [], selected: nil)
        #expect(fromList.path == [.thread("fb_2")])
        #expect(fromList.selection == .thread("fb_2"))
        let other = model.open(request, stacked: [.thread("fb_1")], selected: .new(UUID()))
        #expect(other.path == [.thread("fb_2")])
        #expect(other.selection == .thread("fb_2"))
        // Tapping the same chat's next push is a new request.
        #expect(FeedbackOpenRequest(chat: "fb_2") != request)
    }

    @Test func aConversationStartedHereKeepsItsRouteWhenItsOwnPushOpensIt() async throws {
        let model = FeedbackRequestsModel(client: FeedbackHTTP().client, defaults: nil)
        let route = model.compose(reusing: nil)
        model.binding(for: route.box).wrappedValue = "Bigger clock"
        await model.send(route)
        let chat = try #require(model.thread(for: route))
        let opened = model.open(FeedbackOpenRequest(chat: chat), stacked: [route], selected: route)
        #expect(opened.path == [route])
        #expect(opened.selection == route)
    }
}
