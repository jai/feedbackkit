import Foundation
import Testing
@testable import RunnerMenuCore

/// A status.json as the runner writes it (runner/feedbackkit_runner/service.py, runner.py status()).
func statusJSON(writtenAt: Double = 1_000, pollOK: Bool = true, builderUp: Bool = true, state: String = "delivered",
                messageAt: Double = 990, working: Bool = false, removed: Bool = false) -> String {
    """
    {"version":1,"written_at":\(writtenAt),"pid":4242,"started_at":900,"stopping":false,
     "last_full_tick":{"at":995,"seconds":23.1},"last_fast_tick":null,
     "long_poll":{"on":true,"last_wake":980,"error":null},
     "poll":{"at":995,"ok":\(pollOK),"error":\(pollOK ? "null" : "\"poll answered 503\"")},
     "builders":[{"host":"borg-cube-03","name":"Borg Cube 03","up":\(builderUp),"detail":null}],
     "chats":[{"chat":"fb_8ef88036d98cbb5f","app":"agent-pager","login":"jai","title":"Bigger clock",
       "host":"borg-cube-03","thread":{"host":"borg-cube-03","id":"orca-codex:01a1"},"worktree":"/w",
       "removed":\(removed),"working":\(working),"activity":null,"last_activity":990,
       "messages":[{"id":"m_1","state":"\(state)","detail":"gone","at":\(messageAt),"posted":true}]},
      {"chat":"fb_0000000000000000","app":"prhub","login":"hubot","title":null,"host":null,"thread":null,
       "worktree":null,"removed":false,"working":false,"activity":null,"last_activity":null,"messages":[]}]}
    """
}

func snapshot(_ json: String, loaded: Bool = true, log: [String] = ["a", "b"]) -> String {
    ["noise from the login shell", Snapshot.loadedMark, loaded ? "yes" : "no", Snapshot.statusMark, json, "",
     Snapshot.logMark, log.joined(separator: "\n")].joined(separator: "\n")
}

@Test func theScriptsOutputReadsBackAsASnapshot() throws {
    let read = Snapshot.parse(snapshot(statusJSON()))
    #expect(read.loaded)
    #expect(read.log == ["a", "b"])
    let status = try #require(read.status)
    #expect(status.pid == 4242)
    #expect(status.lastFullTick == .init(at: 995, seconds: 23.1))
    #expect(status.longPoll?.lastWake == 980)
    #expect(status.chats.map(\.name) == ["Bigger clock", "fb_0000000000000000"])
    #expect(status.chats[0].thread == .init(host: "borg-cube-03", id: "orca-codex:01a1"))
    #expect(status.chats[0].state == "delivered")
}

@Test func aMissingOrBrokenStatusSaysWhy() {
    #expect(Snapshot.parse(snapshot("")).statusError == "no status.json yet")
    #expect(Snapshot.parse(snapshot("{")).statusError?.hasPrefix("status.json unreadable") == true)
}

@Test func healthNamesTheFirstProblem() {
    let now = 1_000.0
    func health(_ json: String, loaded: Bool = true, unreachable: String? = nil) -> Health {
        Health.of(Snapshot.parse(snapshot(json, loaded: loaded)), unreachable: unreachable, now: now)
    }
    #expect(health(statusJSON()) == .ok)
    #expect(health(statusJSON(), unreachable: "Operation timed out") == .problem("Mac mini unreachable: Operation timed out"))
    #expect(health(statusJSON(), loaded: false) == .problem("Runner not loaded on the Mac mini"))
    #expect(health(statusJSON(writtenAt: now - 600)) == .problem("Runner silent for 10 min"))
    #expect(health(statusJSON(pollOK: false)) == .problem("FeedbackKit Worker unreachable: poll answered 503"))
    #expect(health(statusJSON(builderUp: false)) == .problem("No builder's Orca answers"))
    #expect(health(statusJSON(state: "failed")) == .problem("A message failed: gone"))
    #expect(health(statusJSON(state: "failed", messageAt: now - 90_000)) == .ok)
    #expect(health(statusJSON(state: "delivering")) == .working)
    #expect(health(statusJSON(working: true)) == .working)
    #expect(Health.of(nil, unreachable: nil, now: now) == .problem("Not checked yet"))
}

@Test func chatsGroupByAppAndATidiedChatGoesAfterADay() throws {
    let now = 1_000.0
    let status = try #require(Snapshot.parse(snapshot(statusJSON(removed: true))).status)
    #expect(status.chatsByApp(now: now).map(\.app) == ["agent-pager", "prhub"])
    #expect(status.chatsByApp(now: now + 90_000).map(\.app) == ["prhub"])
}

@Test func aThreadOpensInAgentPager() throws {
    let url = try #require(threadLink(.init(host: "borg-cube-03", id: "orca-codex:01a1/x")))
    #expect(url.absoluteString == "agentpager://thread/borg-cube-03/orca-codex:01a1%2Fx")
}

@Test func agoReadsInWholeUnits() {
    #expect(ago(nil, now: 100) == "never")
    #expect(ago(88, now: 100) == "12 s ago")
    #expect(ago(100 - 240, now: 100) == "4 min ago")
    #expect(ago(100 - 7_300, now: 100) == "2 h ago")
}

@Test func theScriptAsksForTheRunnersLabelStatusAndLog() {
    let script = Snapshot.script(logLines: 60)
    #expect(script.contains("gui/$(id -u)/com.jai.feedbackkit-runner"))
    #expect(script.contains("feedbackkit-runner/\"/status.json") || script.contains("feedbackkit-runner\"/status.json"))
    #expect(script.contains("tail -n 60"))
}

@Test func sshUnreachableIsItsOwnExit() {
    #expect(SSH.Result(status: 255, output: "", error: "").unreachable)
    #expect(!SSH.Result(status: 1, output: "", error: "").unreachable)
    #expect(lastLine("one\n two \n\n") == "two")
}
