import DurableNetworking
@testable import FeedbackKit
import FeedbackKitTestSupport
import Foundation
import Testing

/// A list read that fails, and one that was only cancelled (Agent Pager fb_3a398e5cb1d2e9ce: New feedback showed
/// "Could not load feedback. Try again." over its composer while the Worker answered every list read 200).
@MainActor
struct FeedbackListErrorTests {
    /// What `URLSession` and structured concurrency throw when the task that asked is cancelled.
    private struct Cancelled: HTTPTransport {
        let error: any Error
        func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) { throw error }
    }

    private func model(_ http: any HTTPTransport) -> FeedbackRequestsModel {
        let rest = DirectHTTP()
        return FeedbackRequestsModel(client: FeedbackClient(direct: FeedbackDirect(
            baseURL: URL(string: "https://worker.test")!, token: { _ in "fixture" }, http: http, streams: rest,
            images: rest
        )), defaults: nil)
    }

    @Test(arguments: [0, 1])
    func aCancelledListReadIsNotAFailure(which: Int) async {
        let errors: [any Error] = [URLError(.cancelled), CancellationError()]
        let model = model(Cancelled(error: errors[which]))
        await model.refresh()
        #expect(model.listError == nil)
        #expect(model.error == nil)
    }

    @Test func aListReadCancelledWithItsTaskIsNotAFailure() async {
        let model = model(URLSessionTransport(policy: .quick))
        let read = Task { await model.refresh() }
        read.cancel()
        await read.value
        #expect(model.listError == nil)
        #expect(model.error == nil)
    }

    @Test func aFailedListReadIsSaidOnTheListAndNotOverAComposer() async {
        let model = model(DirectHTTP(fails: true))
        await model.refresh()
        #expect(model.listError == FeedbackRequestsModel.listProblem)
        // New feedback's composer shows `error`: a list that could not be read keeps nobody from writing.
        #expect(model.error == nil)
    }

    @Test func aListReadAfterAFailedOneClearsWhatTheListSaid() async {
        let model = model(DirectHTTP())
        model.listError = FeedbackRequestsModel.listProblem
        await model.refresh()
        #expect(model.listError == nil)
        #expect(model.hasReadList)
    }

    @Test func aFailedListReadLeavesWhyAMessageDidNotGo() async {
        let model = model(DirectHTTP(fails: true))
        let route = model.compose(reusing: nil)
        model.drafts[route.box] = "One message"
        await model.send(route)
        #expect(model.error == "Could not send feedback. Try again.")
        await model.refresh()
        #expect(model.error == "Could not send feedback. Try again.")
    }
}
