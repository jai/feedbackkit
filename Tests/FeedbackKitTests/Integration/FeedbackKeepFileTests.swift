@testable import FeedbackKit
import FeedbackKitTestSupport
import Foundation
import Testing

/// The list a launch read is on the device for the next one, in a file.
@MainActor
struct FeedbackKeepFileTests {
    @Test func theListReadIsOnScreenAtTheNextLaunchBeforeItsRead() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "feedback-keep-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let keep = FeedbackKeep(file: folder.appending(path: "default/list.json"))
        let worker = FeedbackHTTP()
        let model = FeedbackRequestsModel(client: worker.client, defaults: nil, keep: keep)
        #expect(model.list.threads.isEmpty)
        await model.refresh()
        await model.keeping?.value

        let relaunched = FeedbackRequestsModel(client: worker.client, defaults: nil, keep: keep)

        #expect(relaunched.list.threads.map(\.title) == ["Bigger clock"])
        #expect(worker.requests == ["GET /feedback"], "shown with no read of its own")
        keep.clear()
        #expect(FeedbackRequestsModel(client: worker.client, defaults: nil, keep: keep).list.threads.isEmpty)
    }
}
