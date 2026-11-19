@testable import FeedbackKit
import Foundation
import Testing

/// A row's one status: the agent's work first, then what shipped, then whether it waits on the sender.
struct FeedbackStatusTests {
    private let url = URL(string: "https://github.com/acme/app")!

    private func commit(released: Bool = false, checks: FeedbackShipped.Checks? = .success) -> FeedbackShipped.Commit {
        .init(sha: "a", title: "fix(ios): clock", url: url, checks: checks,
              release: released ? .init(tag: "ios-v1.3.0", name: "ios-v1.3.0", url: url) : nil)
    }

    private enum Agent { case queued, working, needsYou, idle }

    private func status(_ state: Agent?, _ shipped: FeedbackShipped? = nil) -> FeedbackStatus? {
        let agent: FeedbackThreadAgent? = switch state {
        case .queued: FeedbackThreadAgent(state: .working, activity: nil, isQueued: true)
        case .working: FeedbackThreadAgent(state: .working, activity: "Running tests")
        case .needsYou: FeedbackThreadAgent(state: .needsYou)
        case .idle: FeedbackThreadAgent(state: .idle)
        case nil: nil
        }
        return FeedbackStatus(agent: agent, shipped: shipped)
    }

    @Test func theAgentsWorkComesFirst() {
        let released = FeedbackShipped(commits: [commit(released: true)], prs: [])
        #expect(status(.queued, released) == .queued, "a follow-up waiting for the runner")
        #expect(status(.working, released) == .building(activity: "Running tests"))
    }

    @Test func anAgentThatStoppedAfterItShippedIsDoneNotWaiting() {
        let released = FeedbackShipped(commits: [commit(released: true)], prs: [])
        #expect(status(.needsYou, released)?.key == "released")
        #expect(status(.needsYou, FeedbackShipped(commits: [commit()], prs: [])) == .onMain)
        #expect(status(.needsYou, FeedbackShipped(commits: [commit(checks: .failure)], prs: [])) == .checksFailed)
        let failedButReleased = FeedbackShipped(commits: [commit(released: true, checks: .failure)], prs: [])
        #expect(status(.idle, failedButReleased)?.key == "released", "a release outranks a failed check")
        let pr = FeedbackShipped.PullRequest(number: 7, title: "Clock", url: url, state: .open, checks: nil)
        #expect(status(.needsYou, FeedbackShipped(commits: [], prs: [pr])) == .pullRequestOpen)
    }

    @Test func nothingShippedSaysWhetherItWaitsOnTheSender() {
        #expect(status(.needsYou) == .needsYou)
        #expect(status(.idle) == .idle)
        #expect(status(nil) == nil, "an issue chat has no status")
    }

    @Test func anEndedChatDecodesAndAnOlderWorkerIsNotEnded() throws {
        func thread(_ extra: String) throws -> FeedbackThread {
            let row = #"{"id": "fb_1", "title": "Clock", "createdAt": "2026-11-15T00:00:00Z"\#(extra)}"#
            return try JSONDecoder().decode(FeedbackThread.self, from: Data(row.utf8))
        }
        #expect(try thread(#", "ended": true"#).ended)
        #expect(try !thread("").ended)
        let chat = #"{"id": "fb_1", "messages": [], "isWorking": false, "builderOnline": true, "ended": true}"#
        #expect(try JSONDecoder().decode(FeedbackChat.self, from: Data(chat.utf8)).ended)
    }

    @Test func aQueuedStateFromTheWorkerDecodes() throws {
        func agent(_ json: String) throws -> FeedbackThreadAgent? {
            let row = #"{"id": "fb_1", "title": "Clock", "createdAt": "2026-11-15T00:00:00Z", "agent": \#(json)}"#
            return try JSONDecoder().decode(FeedbackThread.self, from: Data(row.utf8)).agent
        }
        #expect(try agent(#"{"state": "working", "activity": null, "queued": true}"#)?.isQueued == true)
        #expect(try agent(#"{"state": "working", "activity": "Building"}"#)?.isQueued == false, "an older Worker")
    }

    @Test func aReleaseNoteOnlyOnceEverythingIsReleased() {
        #expect(FeedbackReleaseNote(shipped: FeedbackShipped(commits: [commit(released: true)], prs: [])) != nil)
        #expect(FeedbackReleaseNote(shipped: FeedbackShipped(commits: [commit()], prs: [])) == nil)
        #expect(FeedbackReleaseNote(shipped: nil) == nil)
    }
}
