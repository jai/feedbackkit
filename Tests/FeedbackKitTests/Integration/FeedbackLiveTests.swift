import AgentChatLive
import AgentChatLiveTesting
import DurableNetworking
@testable import FeedbackKit
import FeedbackKitTestSupport
import Foundation
import SwiftUI
import Testing

@MainActor
struct FeedbackLiveTests {
    private let route = FeedbackRoute.thread("chat-1")

    private func eventually(_ condition: () async -> Bool) async throws {
        for _ in 0..<1000 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("Expected live state was not received")
    }

    private func model(_ rest: DirectHTTP, _ server: LiveDevHost,
                       streams: (any StreamingTransport)? = nil) -> FeedbackRequestsModel {
        FeedbackRequestsModel(client: FeedbackClient(direct: FeedbackDirect(
            baseURL: URL(string: "https://worker.test")!, token: { _ in "fixture" }, http: rest, streams: rest, images: rest,
            liveFactory: { endpoint in
                LiveChatModel(endpoint: LiveEndpoint(acp: server.acp, session: server.session, bearer: endpoint.bearer),
                              http: server, streams: streams ?? server,
                              timing: LiveTiming(backoff: [.milliseconds(5)], jitter: 0,
                                                 backoffResetsAfter: .seconds(10), answerLimit: .seconds(1)))
            }
        )), defaults: nil)
    }

    @Test func directCreationKeepsTheStartingRouteAndNextDraftAcrossNativeSelection() async throws {
        let rest = DirectHTTP()
        let server = LiveDevHost()
        let model = model(rest, server)
        let started = model.compose(reusing: nil)
        model.drafts[started.box] = "Change the screen"
        await model.send(started)
        #expect(model.thread(for: started) == "chat-1")
        model.drafts[started.box] = "Next words"
        #expect(model.route(for: "chat-1", keeping: started) == started)
        #expect(model.draft(for: started.box) == "Next words")
        let requests = await rest.requests
        #expect(requests.map { $0.url!.path } == ["/v2/feedback", "/v2/feedback"])
        #expect(requests.map { $0.httpMethod } == ["POST", "GET"])
        let following = Task { await model.follow(started) }
        defer { following.cancel() }
        try await eventually { model.live(for: started)?.phase == .live }
        #expect(await rest.requests.count == 2, "Creation already supplied the bootstrap snapshot")
    }

    @Test func failedBootstrapDoesNotBlockLiveOrCreateARefreshLoop() async throws {
        let rest = DirectHTTP(statuses: [500])
        let server = LiveDevHost()
        let model = model(rest, server)
        let following = Task { await model.follow(route) }
        try await eventually { model.live(for: route)?.phase == .live }
        await server.agentSays("late", "Live works without REST")
        try await eventually { model.chat(for: route)?.messages.last?.text == "Live works without REST" }
        following.cancel()
        await following.value
        let reopened = Task { await model.follow(route) }
        defer { reopened.cancel() }
        try await eventually { model.live(for: route)?.phase == .live }
        #expect(await rest.requests.count == 1)
    }

    @Test func lateAgentUpdatesAndWorkingToIdleUseOneCachedModelWithoutRESTPolling() async throws {
        let rest = DirectHTTP()
        let server = LiveDevHost()
        let model = model(rest, server)
        let following = Task { await model.follow(route) }
        defer { following.cancel() }
        try await eventually { model.live(for: route)?.phase == .live }
        let first = try #require(model.live(for: route))
        let controls = try #require(model.controls(for: route))
        #expect(controls.live === first)
        await server.setState(.running, activity: "Reading")
        try await eventually { model.chat(for: route)?.activity == "Reading" }
        await server.agentSays("late", "A late answer")
        await server.setState(.idle)
        try await eventually { model.chat(for: route)?.messages.last?.text == "A late answer"
            && model.chat(for: route)?.isWorking == false
        }
        #expect(model.chats["chat-1"]?.messages.isEmpty == true, "REST snapshot is not a stream-fed copy")
        #expect(await rest.requests.map { $0.url!.path } == ["/v2/feedback/chat-1"])
        following.cancel()
        await following.value
        #expect(first.phase == .idle)
        let reopened = Task { await model.follow(route) }
        try await eventually { first.phase == .live }
        #expect(model.live(for: route) === first)
        #expect(model.controls(for: route) === controls)
        reopened.cancel()
        await reopened.value
        #expect(await rest.requests.count == 1)
    }

    @Test func streamFailureReconnectsWithoutFallingBackToREST() async throws {
        let rest = DirectHTTP()
        let server = LiveDevHost()
        let model = model(rest, server)
        let following = Task { await model.follow(route) }
        defer { following.cancel() }
        try await eventually { model.live(for: route)?.phase == .live }
        await server.setDown(true)
        try await eventually { model.live(for: route)?.phase == .reconnecting }
        #expect(await rest.requests.count == 1)
        await server.agentSays("late", "While disconnected")
        await server.setDown(false)
        try await eventually { model.chat(for: route)?.messages.last?.id == "late" }
        #expect(await rest.requests.count == 1)
    }

    @Test func foregroundAndHostedLifecycleDoNotOpenHiddenStreams() async throws {
        let rest = DirectHTTP()
        let server = LiveDevHost()
        let model = model(rest, server)
        await model.follow(route, isForeground: false)
        await model.follow(route, isHosted: true)
        #expect(model.liveChats.isEmpty)
        let following = Task { await model.follow(route) }
        try await eventually { model.live(for: route)?.phase == .live }
        await model.follow(route, isHosted: true)
        await following.value
        #expect(model.live(for: route)?.phase == .idle)
        #expect(await rest.requests.count == 1)
    }

    @Test func streamedMetadataAndDeliveredTicksGateHandoffAndPreserveTheDraftTray() async throws {
        let rest = DirectHTTP()
        let server = LiveDevHost()
        await server.publish([
            "sessionUpdate": "user_message", "messageId": "sent",
            "content": [["type": "text", "text": "Change this"]],
            "_meta": ["agentchatkit": ["status": "pending"]],
        ])
        let model = model(rest, server, streams: MetadataStream(server: server))
        let following = Task { await model.follow(route) }
        defer { following.cancel() }
        try await eventually { model.live(for: route)?.phase == .live }
        model.drafts[route.box] = "Keep these words"
        let tray = model.attachments(for: route.box)
        var received: FeedbackConversation?
        let view = FeedbackChatView(model: model, route: route, conversation: {
            received = $0
            return AnyView(EmptyView())
        })
        #expect(view.hostedConversation == nil)
        #expect(model.chat(for: route)?.costCents == 12)
        #expect(model.chat(for: route)?.builderOnline == false)
        await server.setStatus("sent", .delivered)
        try await eventually { model.chat(for: route)?.delivery["sent"] == .delivered }
        #expect(view.hostedConversation != nil)
        #expect(received?.thread == FeedbackAgentThread(host: "builder", id: "session"))
        #expect(received?.draft.wrappedValue == "Keep these words")
        #expect(received?.attachments === tray)
    }
}

/// Adds FeedbackKit's state extension to the real ACP stream, including replayed snapshots.
private struct MetadataStream: StreamingTransport {
    let server: LiveDevHost
    func open(_ request: URLRequest) async throws -> LineStream {
        let stream = try await server.open(request)
        let lines = LineStream.Lines { continuation in
            let reader = Task {
                do {
                    for try await line in stream.lines {
                        guard let value = LiveEventParser().message(from: line),
                              var envelope = value.object,
                              var params = value["params"]?.object,
                              var update = value.at("params", "update")?.object,
                              update["sessionUpdate"] == "state_update" else {
                            continuation.yield(line)
                            continue
                        }
                        var ours = value.at("params", "update", "_meta", "agentchatkit")?.object ?? [:]
                        ours["extra"] = ["builderOnline": false, "thread": ["host": "builder", "id": "session"],
                                         "costCents": 12]
                        update["_meta"] = ["agentchatkit": .object(ours)]
                        params["update"] = .object(update)
                        envelope["params"] = .object(params)
                        let data = try JSONValue.object(envelope).data()
                        continuation.yield("data: " + String(decoding: data, as: UTF8.self))
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in reader.cancel() }
        }
        return LineStream(response: stream.response, lines: lines)
    }
}
