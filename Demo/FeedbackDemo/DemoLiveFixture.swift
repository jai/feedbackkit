import AgentChatLiveTesting
import DurableNetworking
import FeedbackKit
import Foundation

/// REST bootstrap/creation plus the real ACP dev host on localhost. No production calls or client-state writes.
actor DemoLiveFixture: HTTPTransport {
    let server = LiveDevHost(
        base: URL(string: ProcessInfo.processInfo.environment["FEEDBACKKIT_LIVE_SERVER"] ?? "http://127.0.0.1:8788")!,
        session: "feedback-fixture-\(UUID().uuidString)"
    )
    let scenario: String
    let screenshot: Data
    private var prepared = false
    private var sent: [String: String] = [:]

    init(scenario: String, screenshot: Data) { self.scenario = scenario; self.screenshot = screenshot }

    @MainActor static func model(scenario: String) -> FeedbackRequestsModel {
        let image = Bundle.main.url(forResource: "live-feedback", withExtension: "png")
            .flatMap { try? Data(contentsOf: $0) } ?? Data()
        let fixture = DemoLiveFixture(scenario: scenario, screenshot: image)
        let server = fixture.server
        return FeedbackRequestsModel(client: FeedbackClient(direct: FeedbackDirect(
            baseURL: URL(string: "https://fixture.invalid")!, token: { _ in "fixture" }, http: fixture,
            streams: server, images: fixture,
            liveFactory: { endpoint in
                LiveChatModel(endpoint: LiveEndpoint(acp: server.acp, session: server.session, bearer: endpoint.bearer),
                              http: fixture, streams: server)
            }
        )))
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        await prepare()
        if request.url == server.acp {
            let answer = try await server.send(request)
            if scenario == "question", (200..<300).contains(answer.1.statusCode), let data = request.httpBody,
               let body = try? JSONValue.decode(data), body.at("result", "action")?.string == "accept" {
                let choice = body.at("result", "content", "choice")?.string ?? ""
                await server.agentSays("answered", "Answer received: " + choice)
                await server.setState(.idle)
            }
            return answer
        }
        if request.url!.path.contains("/images/") { return response(screenshot, request) }
        if request.httpMethod == "POST", let data = request.httpBody {
            let body = try JSONValue.decode(data)
            let ref = body["client_ref"]?.string ?? "fixture"
            if sent[ref] == nil {
                let id = "http-\(sent.count)"
                sent[ref] = id
                await server.publish(Self.message(id, body["text"]?.string ?? "", .pending, clientRef: ref))
                Task {
                    await server.setStatus(id, .delivered)
                    await server.agentSays("answer-\(id)", "Live answer to your feedback")
                    await server.setState(.idle)
                }
            }
        }
        let body: JSONValue
        if request.url!.path == "/v2/feedback", request.httpMethod != "POST" {
            body = ["threads": [["id": .string(server.session), "title": "Direct live feedback",
                                 "createdAt": "2026-11-15T00:00:00Z",
                                 "thread": ["host": "fixture", "id": "agent"]]], "builderOnline": true]
        } else {
            body = ["id": .string(server.session), "messages": [], "isWorking": false, "builderOnline": true]
        }
        return response(try body.data(), request)
    }

    private func prepare() async {
        guard !prepared else { return }
        prepared = true
        await server.setState(.running, activity: "Reading the feedback")
        switch scenario {
        case "queue":
            await server.publish(Self.message("edit", "Edit these queued words", .queued))
            await server.publish(Self.message("remove", "Remove this queued reply", .queued))
            await server.publish(Self.message("now", "Send this reply now", .queued))
        case "question":
            await server.ask("Where should this change appear?", options: [
                .init(id: "phone", label: "iPhone"), .init(id: "mac", label: "Mac"),
            ], freeText: false)
        case "screenshots":
            await server.publish([
                "sessionUpdate": "user_message", "messageId": "picture",
                "content": [["type": "text", "text": "Screenshot of the feedback list"],
                            ["type": "resource_link", "name": "feedback.png", "mimeType": "image/png",
                             "uri": "/v2/feedback/direct-fixture/images/picture/0"]],
                "_meta": ["agentchatkit": ["status": "delivered"]],
            ])
            await server.setState(.idle)
        default:
            await server.publish(Self.message("delivered", "This reached the agent", .delivered))
            await server.publish(Self.message("pending", "This can still be cancelled", .pending))
            await server.publish(Self.message("failed", "Retry this reply", .failed))
        }
    }

    private static func message(_ id: String, _ text: String, _ status: LiveMessage.Status,
                                clientRef: String? = nil) -> JSONValue {
        var ours: [String: JSONValue] = ["status": .string(status.rawValue)]
        if let clientRef { ours["clientRef"] = .string(clientRef) }
        return ["sessionUpdate": "user_message", "messageId": .string(id),
                "content": [["type": "text", "text": .string(text)]],
                "_meta": ["agentchatkit": .object(ours)]]
    }

    private func response(_ data: Data, _ request: URLRequest) -> (Data, HTTPURLResponse) {
        (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
