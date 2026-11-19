import AgentChatLive
@testable import FeedbackKit
import Testing

struct FeedbackLiveMetadataTests {
    @Test func blankOrAbsentLiveThreadReferencesDoNotReuseBootstrapReferences() throws {
        let bootstrap = FeedbackChat(id: "chat-1", messages: [], isWorking: false, activity: nil,
                                     problem: nil, costCents: 9, builderOnline: true,
                                     thread: .init(host: "old", id: "old"))
        let extras: [JSONValue] = [.null, ["thread": ["host": " ", "id": "session"]],
                                   ["thread": ["host": "builder", "id": ""]]]
        for extra in extras {
            var live = LiveChat()
            live.take(.update(["sessionUpdate": "state_update", "state": "idle",
                               "_meta": ["agentchatkit": ["extra": extra]]], cursor: "1"))
            let chat = FeedbackChat(live: live, id: "chat-1", bootstrap: bootstrap)
            #expect(chat.thread == nil)
            #expect(chat.costCents == 9)
        }
    }
}
