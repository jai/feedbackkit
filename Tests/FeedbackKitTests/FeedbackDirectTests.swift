import AgentChatLive
import AgentChatLiveTesting
import DurableNetworking
import Foundation
import Testing
@testable import FeedbackKit

@MainActor
struct FeedbackDirectTests {
    @Test func creationRenewsOnlyAfter401AndPreservesBodyBuildImagesAndClientRef() async throws {
        let rest = DirectHTTP(statuses: [401, 200])
        let tokens = TokenCalls()
        let client = FeedbackClient(direct: FeedbackDirect(
            baseURL: URL(string: "https://worker.test")!, token: tokens.token, http: rest
        ))
        let message = FeedbackMessage(text: "Change it", build: "42", images: [.init(jpeg: Data([1, 2, 3]))],
                                      client_ref: "once")
        _ = try await client.send(message, to: nil)
        let requests = await rest.requests
        #expect(requests.count == 2)
        #expect(requests.allSatisfy { $0.url?.path == "/v2/feedback" && $0.httpMethod == "POST" })
        #expect(requests[0].httpBody == requests[1].httpBody)
        let body = try JSONValue.decode(#require(requests[1].httpBody))
        #expect(body["build"]?.string == "42")
        #expect(body["client_ref"]?.string == "once")
        #expect(body["images"]?.array?.count == 1)
        #expect(await tokens.calls == [false, true])
        #expect(requests[0].value(forHTTPHeaderField: "Authorization") == "Bearer initial-fixture")
        #expect(requests[1].value(forHTTPHeaderField: "Authorization") == "Bearer renewed-fixture")
    }

    @Test func aSecond401StopsAndUnknownNetworkFailureNeverRetriesAutomatically() async throws {
        for rest in [DirectHTTP(statuses: [401, 401]), DirectHTTP(fails: true)] {
            let tokens = TokenCalls()
            let client = FeedbackClient(direct: FeedbackDirect(
                baseURL: URL(string: "https://worker.test")!, token: tokens.token, http: rest
            ))
            do { _ = try await client.send(.init(text: "One", build: nil, images: [], client_ref: "one"), to: nil)
                Issue.record("Expected refusal")
            } catch {}
            let requests = await rest.requests
            #expect(requests.count == (await tokens.calls.count))
            #expect(requests.count <= 2)
        }
    }

    @Test func aManualResendAfterAnUnknownFailureReusesTheIdempotencyKeyAndRouteDraft() async throws {
        let rest = DirectHTTP(fails: true)
        let model = FeedbackRequestsModel(client: FeedbackClient(direct: FeedbackDirect(
            baseURL: URL(string: "https://worker.test")!, token: { _ in "fixture" }, http: rest
        )))
        let route = model.compose(reusing: nil)
        model.drafts[route.box] = "One message"
        await model.send(route)
        #expect(model.draft(for: route.box) == "One message")
        #expect(model.thread(for: route) == nil)
        #expect(await rest.requests.count == 1)
        await model.send(route)
        let requests = await rest.requests
        #expect(requests.count == 2)
        let firstBody = try JSONValue.decode(#require(requests[0].httpBody))
        let secondBody = try JSONValue.decode(#require(requests[1].httpBody))
        #expect(firstBody == secondBody)
    }

    @Test func imagesAuthenticateOnlySameOriginAndRenewOnceWithoutLeakingToExternalOrigins() async throws {
        let images = DirectHTTP(statuses: [401, 200, 200, 200])
        let tokens = TokenCalls()
        let direct = FeedbackDirect(baseURL: URL(string: "https://worker.test")!, token: tokens.token,
                                    images: images)
        for uri in ["/v2/feedback/chat-1/images/m1/0", "https://cdn.test/signed.png?signature=fixture",
                    "https://worker.test:8443/other.png"] {
            let attachment = try attachment(uri)
            guard case .success = await direct.loadScreenshot(attachment) else {
                Issue.record("Expected image bytes")
                return
            }
        }
        let requests = await images.requests
        #expect(requests.count == 4)
        #expect(requests[0].url?.path == "/v2/feedback/chat-1/images/m1/0")
        #expect(requests[0].value(forHTTPHeaderField: "Authorization") == "Bearer initial-fixture")
        #expect(requests[1].value(forHTTPHeaderField: "Authorization") == "Bearer renewed-fixture")
        #expect(requests[2].value(forHTTPHeaderField: "Authorization") == nil)
        #expect(requests[3].value(forHTTPHeaderField: "Authorization") == nil)
        #expect(await tokens.calls == [false, true])
    }

    @Test func externalImage401DoesNotRequestAFeedbackTokenOrRetry() async throws {
        let images = DirectHTTP(statuses: [401])
        let tokens = TokenCalls()
        let direct = FeedbackDirect(baseURL: URL(string: "https://worker.test")!, token: tokens.token,
                                    images: images)
        guard case .failure = await direct.loadScreenshot(try attachment("https://cdn.test/expired.png")) else {
            Issue.record("Expected expired external image to fail")
            return
        }
        #expect(await images.requests.count == 1)
        #expect(await tokens.calls.isEmpty)
    }

    @Test func unsafeImageSchemesAndCredentialsAreRejectedBeforeTransportOrTokenAccess() async throws {
        let images = DirectHTTP()
        let tokens = TokenCalls()
        let direct = FeedbackDirect(baseURL: URL(string: "https://worker.test")!, token: tokens.token,
                                    images: images)
        for uri in ["file:///private/photo.png", "data:image/png;base64,eA==", "http://worker.test/image",
                    "https://user:password@worker.test/image", "javascript:alert(1)"] {
            guard case .failure = await direct.loadScreenshot(try attachment(uri)) else {
                Issue.record("Expected unsupported image to be refused")
                return
            }
        }
        #expect(await images.requests.isEmpty)
        #expect(await tokens.calls.isEmpty)
    }

    @Test func liveUsesExplicitV2EndpointAndTheRenewableProvider() async throws {
        let server = LiveDevHost()
        await server.accept(bearer: "renewed-fixture")
        let tokens = TokenCalls()
        let endpoint = EndpointCapture()
        let direct = FeedbackDirect(baseURL: URL(string: "https://worker.test")!, token: tokens.token,
                                    liveFactory: { value in
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

    private func attachment(_ uri: String) throws -> LiveAttachment {
        var chat = LiveChat()
        chat.take(.update(["sessionUpdate": "user_message", "messageId": "m1", "content": [
            ["type": "resource_link", "uri": .string(uri), "mimeType": "image/png"],
        ]], cursor: "1"))
        return try #require(chat.message("m1")?.attachments.first)
    }
}

private actor TokenCalls {
    private(set) var calls: [Bool] = []
    func token(_ renew: Bool) -> String {
        calls.append(renew)
        return renew ? "renewed-fixture" : "initial-fixture"
    }
}

@MainActor
private final class EndpointCapture { var url: URL? }
