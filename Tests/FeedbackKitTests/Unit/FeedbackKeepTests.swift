@testable import FeedbackKit
import FeedbackKitTestSupport
import Foundation
import Synchronization
import Testing

/// Feedback opens on the requests it last had, never on an empty list (Jai, 2026-11-24: "I never want to see this
/// loading screen we must cache aggressively locally"), and says nothing of the builder until it has read.
@MainActor
struct FeedbackKeepTests {
    /// A keep in memory: a unit test touches no disk.
    private final class Memory: Sendable {
        let data = Mutex<Data?>(nil)
        var keep: FeedbackKeep {
            FeedbackKeep(
                load: { self.data.withLock { $0 } }, save: { data in self.data.withLock { $0 = data } },
                remove: { self.data.withLock { $0 = nil } }
            )
        }
    }

    private static let kept = #"""
    {"threads": [{"id": "sesn_0", "title": "Kept from before", "createdAt": "2026-11-04T09:00:00Z"}],
     "builderOnline": false}
    """#

    /// The model began with an empty list and "offline" until its read answered, at every launch.
    @Test func theListKeptFromBeforeShowsBeforeAnyReadThenTheReadTakesItsPlaceAndIsKept() async throws {
        let memory = Memory()
        memory.data.withLock { $0 = Data(Self.kept.utf8) }
        let worker = FeedbackHTTP()
        let model = FeedbackRequestsModel(client: worker.client, defaults: nil, keep: memory.keep)

        #expect(model.list.threads.map(\.title) == ["Kept from before"] && worker.requests.isEmpty)
        #expect(!model.hasReadList, "what it kept says nothing of the builder now")

        await model.refresh()
        await model.keeping?.value

        #expect(model.list.threads.map(\.title) == ["Bigger clock"] && model.hasReadList)
        let again = FeedbackRequestsModel(client: worker.client, defaults: nil, keep: memory.keep)
        #expect(again.list.threads.map(\.title) == ["Bigger clock"] && again.list.builderOnline)
    }

    @Test func withNothingKeptTheListIsEmptyAndDoesNotSayTheBuilderIsOffline() {
        let model = FeedbackRequestsModel(client: FeedbackHTTP().client, defaults: nil, keep: Memory().keep)

        #expect(model.list.threads.isEmpty && !model.hasReadList)
    }

    /// The same list read twice is written once: nothing changed.
    @Test func aListReadAgainUnchangedIsNotWrittenAgain() async {
        let writes = Mutex(0)
        let keep = FeedbackKeep(load: { nil }, save: { _ in writes.withLock { $0 += 1 } })
        let model = FeedbackRequestsModel(client: FeedbackHTTP().client, defaults: nil, keep: keep)

        await model.refresh()
        await model.keeping?.value
        await model.refresh()
        await model.keeping?.value

        #expect(writes.withLock { $0 } == 1)
    }

    /// A kept list is written with the Worker's own names, so the Worker's decoders read it back whole: the agent's
    /// state, what shipped, the coding thread and a chat that ended.
    @Test func aKeptListIsReadBackAsTheWorkerSentIt() throws {
        let json = #"""
        {"threads": [
          {"id": "sesn_1", "title": "Bigger clock", "createdAt": "2026-11-05T09:00:00Z", "ended": true,
           "thread": {"host": "builder", "id": "codex:session-1"},
           "agent": {"state": "needs_you", "activity": "Asked which clock", "queued": true, "asks": true},
           "shipped": {"commits": [{"sha": "abc1234", "title": "fix: bigger clock",
                                    "url": "https://github.com/jai/app/commit/abc1234", "ci": "success",
                                    "release": {"tag": "v1.2.0", "name": "1.2.0",
                                                "url": "https://github.com/jai/app/releases/tag/v1.2.0",
                                                "prerelease": false}}],
                       "prs": [{"number": 7, "title": "Bigger clock", "url": "https://github.com/jai/app/pull/7",
                                "state": "merged", "ci": "pending"}]}},
          {"id": "sesn_2", "title": "Plain", "createdAt": "2026-11-06T09:00:00Z"}
         ],
         "builderOnline": true, "notice": "Sending opens a public GitHub issue."}
        """#
        let list = try JSONDecoder().decode(FeedbackList.self, from: Data(json.utf8))
        let memory = Memory()

        memory.keep.keep(list)

        #expect(memory.keep.list() == list)
        #expect(list.threads.first?.agent?.asks == true && list.threads.first?.shipped?.prs.first?.checks == .pending)
        memory.keep.clear()
        #expect(memory.keep.list() == nil)
    }
}
