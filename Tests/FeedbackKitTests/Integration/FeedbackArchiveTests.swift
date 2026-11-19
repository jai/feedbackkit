@testable import FeedbackKit
import FeedbackKitTestSupport
import Foundation
import Testing

@MainActor
struct FeedbackArchiveTests {
    @Test func anArchivedChatLeavesTheListOnThisDeviceOnlyAndComesBack() async throws {
        let suite = "FeedbackRequestsModelTests.archive.\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let worker = FeedbackHTTP()
        let model = FeedbackRequestsModel(client: worker.client, defaults: defaults)
        await model.refresh()
        model.archive("sesn_1")
        #expect(model.visibleThreads.isEmpty)
        #expect(model.archivedThreads.map(\.id) == ["sesn_1"])
        #expect(worker.requests == ["GET /feedback"], "archive asks nothing of the Worker")

        let again = FeedbackRequestsModel(client: worker.client, defaults: defaults)
        await again.refresh()
        #expect(again.visibleThreads.isEmpty, "kept on this device")
        again.unarchive("sesn_1")
        #expect(again.visibleThreads.map(\.id) == ["sesn_1"])
        #expect(FeedbackRequestsModel(client: worker.client, defaults: defaults).archived.isEmpty)
    }
}
