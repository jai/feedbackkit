import AgentChatLive
import AgentChatLiveTesting
@testable import FeedbackKit
import FeedbackKitTestSupport
import Foundation
import Testing

@MainActor
struct FeedbackDirectLiveTests {
    @Test func liveUsesExplicitV2EndpointAndTheRenewableProvider() async throws {
        let server = LiveDevHost()
        await server.accept(bearer: "renewed-fixture")
        let tokens = TokenCalls()
        let endpoint = EndpointCapture()
        let rest = DirectHTTP()
        let direct = FeedbackDirect(baseURL: URL(string: "https://worker.test")!, token: { renew in await tokens.token(renew) },
                                    http: rest, streams: rest, images: rest, liveFactory: { value in
                                        endpoint.url = value.acp
                                        return LiveChatModel(endpoint: LiveEndpoint(acp: server.acp, session: server.session, bearer: value.bearer),
                                                             http: server, streams: server)
                                    })
        let live = direct.makeLive("chat-1")
        let following = Task { await live.follow() }
        defer { following.cancel() }
        for _ in 0..<1000 {
            if live.phase == .live { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(live.phase == .live)
        #expect(endpoint.url?.path == "/v2/acp")
        #expect(await tokens.calls == [false, true])
    }
}

@MainActor
private final class EndpointCapture { var url: URL? }
