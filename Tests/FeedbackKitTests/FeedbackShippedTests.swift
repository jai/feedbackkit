import Foundation
import Testing
@testable import FeedbackKit

/// What a chat shipped, as the Worker serves it on list rows and chats (docs/api.md#shipped).
struct FeedbackShippedTests {
    private func commit(_ sha: Character, release: String? = nil, ci: String = "success") -> String {
        let hash = String(repeating: sha, count: 40)
        let carried = release.map {
            #"{"tag": "\#($0)", "name": "Build \#($0)", "url": "https://github.com/acme/app/releases/tag/\#($0)", "prerelease": false}"#
        } ?? "null"
        return #"{"sha": "\#(hash)", "title": "fix \#(sha)", "at": null, "url": "https://github.com/acme/app/commit/\#(hash)", "ci": "\#(ci)", "release": \#(carried)}"#
    }

    private func shipped(commits: [String] = [], prs: [String] = []) throws -> FeedbackShipped? {
        let row = #"{"id": "fb_1", "title": "Clock", "createdAt": "2026-11-15T00:00:00Z", "shipped": {"commits": [\#(commits.joined(separator: ","))], "prs": [\#(prs.joined(separator: ","))]}}"#
        return try JSONDecoder().decode(FeedbackThread.self, from: Data(row.utf8)).shipped
    }

    @Test func aRowSaysWhereItsFeedbackStands() throws {
        #expect(try shipped() == nil, "nothing shipped: no accessory")
        let pr = #"{"number": 7, "title": "Clock", "url": "https://github.com/acme/app/pull/7", "state": "open", "ci": "pending"}"#
        #expect(try shipped(prs: [pr])?.stage == .pullRequestOpen)
        #expect(try shipped(prs: [pr])?.checks == .pending)
        #expect(try shipped(commits: [commit("b", release: "12"), commit("a")])?.stage == .onMain,
                "a commit in no release yet: on main")
        let released = try #require(try shipped(commits: [commit("b", release: "12"), commit("a", release: "11")]))
        #expect(released.stage?.label == "In Build 12", "the newest commit's release")
        #expect(try shipped(commits: [commit("a", ci: "failure"), commit("b")])?.checks == .failure)
    }

    @Test func aMalformedShippedIsNoneNotAFailedList() throws {
        let row = #"{"id": "fb_1", "title": "Clock", "createdAt": "2026-11-15T00:00:00Z", "shipped": {"commits": "no"}}"#
        let thread = try JSONDecoder().decode(FeedbackThread.self, from: Data(row.utf8))
        #expect(thread.shipped == nil)
        #expect(thread.title == "Clock")
    }

    @Test func theChatCarriesItForItsHeader() throws {
        let chat = #"{"id": "fb_1", "messages": [], "isWorking": false, "builderOnline": true, "shipped": {"commits": [\#(commit("a"))], "prs": []}}"#
        let decoded = try JSONDecoder().decode(FeedbackChat.self, from: Data(chat.utf8))
        #expect(decoded.shipped?.commits.map(\.title) == ["fix a"])
        #expect(decoded.shipped?.commits.first?.checks == .success)
    }
}
