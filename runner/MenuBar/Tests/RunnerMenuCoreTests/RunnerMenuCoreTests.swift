import Foundation
@testable import RunnerMenuCore
import Testing

/// A status.json as the runner writes it (runner/feedbackkit_runner/service.py, runner.py status()).
/// `builders` replaces the one builder; `extra` adds top-level fields (`update`, `builders_config_error`).
func statusJSON(writtenAt: Double = 1_000, pollOK: Bool = true, builderUp: Bool = true, state: String = "delivered",
                messageAt: Double = 990, working: Bool = false, removed: Bool = false, builders: String? = nil,
                extra: String = "") -> String {
    """
    {"version":1,"written_at":\(writtenAt),"pid":4242,"started_at":900,"stopping":false,\(extra)
     "last_full_tick":{"at":995,"seconds":23.1},"last_fast_tick":null,
     "long_poll":{"on":true,"last_wake":980,"error":null},
     "poll":{"at":995,"ok":\(pollOK),"error":\(pollOK ? "null" : "\"poll answered 503\"")},
     "builders":\(builders ?? "[{\"host\":\"borg-cube-03\",\"name\":\"Borg Cube 03\",\"up\":\(builderUp),\"detail\":null}]"),
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
        Health.of(Snapshot.parse(snapshot(json, loaded: loaded)), unreachable: unreachable, dismissed: [], now: now)
    }
    #expect(health(statusJSON()) == .ok)
    #expect(health(statusJSON(), unreachable: "Operation timed out") == .problem("Mac mini unreachable: Operation timed out"))
    #expect(health(statusJSON(), loaded: false) == .problem("Runner not loaded on the Mac mini"))
    #expect(health(statusJSON(writtenAt: now - 600)) == .problem("Runner silent for 10 min"))
    #expect(health(statusJSON(pollOK: false)) == .problem("FeedbackKit Worker unreachable: poll answered 503"))
    #expect(health(statusJSON(builderUp: false)) == .problem("No builder's Orca answers"))
    #expect(health(statusJSON(state: "failed")) == .failed(key: "fb_8ef88036d98cbb5f/m_1", reason: "gone"))
    #expect(health(statusJSON(state: "failed")).summary == "A message failed: gone")
    #expect(health(statusJSON(state: "failed", messageAt: now - 90_000)) == .ok)
    #expect(health(statusJSON(state: "delivering")) == .working)
    #expect(health(statusJSON(working: true)) == .working)
    #expect(Health.of(nil, unreachable: nil, dismissed: [], now: now) == .problem("Not checked yet"))
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

/// Two builders: cube 03 first and up, cube 04 down; `off` turns builders off.
func twoBuilders(off: Set<String> = [], up03: Bool = true) -> String {
    """
    [{"host":"borg-cube-03","name":"Borg Cube 03","up":\(up03),"detail":null,"on":\(!off.contains("borg-cube-03"))},
     {"host":"borg-cube-04","name":"Borg Cube 04","up":false,"detail":"Borg Cube 04: no answer","on":\(!off.contains("borg-cube-04"))}]
    """
}

func status(_ json: String) throws -> RunnerStatus {
    try RunnerStatus.decode(Data(json.utf8))
}

@Test func anOlderStatusWithoutOnUpdateOrConfigErrorStillReads() throws {
    let read = try status(statusJSON())
    #expect(read.builders == [.init(host: "borg-cube-03", name: "Borg Cube 03", up: true, on: true)])
    #expect(read.builders[0].state == .up)
    #expect(read.update == nil)
    #expect(read.buildersConfigError == nil)
}

@Test func theStatusReadsBuildersOnTheUpdaterAndWhyBuildersJSONWasIgnored() throws {
    let extra = """
    "update":{"installed":"v0.12.0","last_check":990,"error":"GitHub answered 502"},"builders_config_error":"order is not a list",
    """
    let read = try status(statusJSON(builders: twoBuilders(off: ["borg-cube-03"]), extra: extra))
    #expect(read.builders.map(\.state) == [.off, .down("Borg Cube 04: no answer")])
    #expect(read.update == .init(installed: "v0.12.0", lastCheck: 990, error: "GitHub answered 502"))
    #expect(read.buildersConfigError == "order is not a list")
    let empty = try status(statusJSON(extra: #""update":{},"builders_config_error":null,"#))
    #expect(empty.update == .init(installed: nil, lastCheck: nil, error: nil))
    #expect(versionsLine(menu: "0.12.0", runner: read.update) == "Menu 0.12.0 · Runner v0.12.0")
    #expect(versionsLine(menu: "0.0.0", runner: nil) == "Menu 0.0.0 · Runner unknown")
}

@Test func healthCountsOnlyTheBuildersTakingNewChats() {
    func health(_ builders: String) -> Health {
        Health.of(Snapshot.parse(snapshot(statusJSON(builders: builders))), unreachable: nil, dismissed: [], now: 1_000)
    }
    #expect(health(twoBuilders()) == .ok)
    #expect(health(twoBuilders(off: ["borg-cube-04"])) == .ok)
    #expect(health(twoBuilders(up03: false)) == .problem("No builder's Orca answers"))
    #expect(health(twoBuilders(off: ["borg-cube-03"])) == .problem("No builder taking new chats answers"))
    #expect(health(twoBuilders(off: ["borg-cube-03", "borg-cube-04"])) == .problem("Every builder is turned off"))
}

@Test func aDismissedFailedMessageIsNoProblemAndItsChatStays() throws {
    let json = statusJSON(state: "failed")
    let read = Snapshot.parse(snapshot(json))
    #expect(Health.of(read, unreachable: nil, dismissed: ["fb_8ef88036d98cbb5f/m_1"], now: 1_000) == .ok)
    #expect(Health.of(read, unreachable: nil, dismissed: ["fb_0000000000000000/m_1"], now: 1_000) == .failed(key: "fb_8ef88036d98cbb5f/m_1", reason: "gone"))
    #expect(try status(json).chatsByApp(now: 1_000).flatMap(\.chats).map(\.chat).contains("fb_8ef88036d98cbb5f"))
}

@Test func dismissalsGoAfterTwoDaysOrWhenTheStatusNoLongerListsTheMessage() throws {
    let read = try status(statusJSON(state: "failed"))
    var dismissed = Dismissed()
    dismissed.add("fb_8ef88036d98cbb5f/m_1", now: 1_000)
    dismissed.add("fb_8ef88036d98cbb5f/m_gone", now: 1_000)
    #expect(dismissed.pruned(by: read, now: 2_000).keys == ["fb_8ef88036d98cbb5f/m_1"])
    #expect(dismissed.pruned(by: read, now: 1_000 + Dismissed.keptFor).keys.isEmpty)
}

@Test func versionsCompareByNumber() {
    #expect(Version("v0.12.0") == Version(major: 0, minor: 12, patch: 0))
    #expect(Version("1.2.3-rc.1") == Version(major: 1, minor: 2, patch: 3))
    #expect(Version("1.2") == nil)
    #expect(Version("1.2.x") == nil)
    #expect(Version("") == nil)
    #expect(Version("0.10.0")! > Version("0.9.12")!)
    #expect(Version("1.0.0")! > Version("0.99.99")!)
    #expect(Version("0.12.0")?.description == "0.12.0")
}

@Test func aNewerPublishedMenuIsAnUpdateButADevBuildNeverNags() throws {
    let release = try MenuRelease.decode(Data(#"{"version":"0.12.0","commit":"abc1234","tag":"v0.12.0"}"#.utf8))
    #expect(release == .init(version: "0.12.0", commit: "abc1234", tag: "v0.12.0"))
    #expect(release.newer(than: "0.11.3") == Version(major: 0, minor: 12, patch: 0))
    #expect(release.newer(than: "0.12.0") == nil)
    #expect(release.newer(than: "0.13.0") == nil)
    #expect(release.newer(than: "0.0.0") == nil)
    #expect(release.newer(than: "dev") == nil)
    #expect(try MenuRelease.decode(Data(#"{"version":"0.12.1"}"#.utf8)).newer(than: "0.12.0") != nil)
    #expect(MenuRelease(version: "next").newer(than: "0.12.0") == nil)
    #expect(throws: DecodingError.self) { try MenuRelease.decode(Data(#"{"tag":"v0.12.0"}"#.utf8)) }
}

@Test func theMenuLooksForAnUpdateWhenItHasNotOrTheLastLookIsOldEnough() {
    #expect(MenuRelease.due(lastCheck: nil, now: 1_000, after: MenuRelease.checkEvery))
    #expect(!MenuRelease.due(lastCheck: 1_000, now: 1_000 + 3_599, after: MenuRelease.checkEvery))
    #expect(MenuRelease.due(lastCheck: 1_000, now: 1_000 + 3_600, after: MenuRelease.checkEvery))
    #expect(MenuRelease.due(lastCheck: 1_000, now: 1_300, after: MenuRelease.checkOnRefreshAfter))
    #expect(!MenuRelease.due(lastCheck: 1_000, now: 1_299, after: MenuRelease.checkOnRefreshAfter))
}

@Test func buildersConfigStartsFromTheStatusAndChangesOneThing() throws {
    let read = try status(statusJSON(builders: twoBuilders(off: ["borg-cube-04"])))
    let config = BuildersConfig(read)
    #expect(config == .init(order: ["borg-cube-03", "borg-cube-04"], off: ["borg-cube-04"]))
    #expect(config.turning("borg-cube-04", on: true) == .init(order: ["borg-cube-03", "borg-cube-04"], off: []))
    #expect(config.turning("borg-cube-03", on: false) == .init(order: ["borg-cube-03", "borg-cube-04"], off: ["borg-cube-04", "borg-cube-03"]))
    #expect(config.turning("borg-cube-04", on: false) == config)
    #expect(config.tryingFirst("borg-cube-04") == .init(order: ["borg-cube-04", "borg-cube-03"], off: ["borg-cube-04"]))
    #expect(config.tryingFirst("borg-cube-03") == config)
    let older = try status(statusJSON())
    #expect(BuildersConfig(older) == .init(order: ["borg-cube-03"], off: []))
}

@Test func buildersJSONIsWrittenWholeThenMovedIntoPlace() {
    let config = BuildersConfig(order: ["borg-cube-04", "borg-cube-03"], off: ["borg-cube-04"])
    #expect(config.json() == #"{"off":["borg-cube-04"],"order":["borg-cube-04","borg-cube-03"]}"#)
    let script = config.writeScript()
    #expect(script.contains("feedbackkit-runner\""))
    #expect(script.contains("umask 077"))
    #expect(script.contains("cat > builders.json.tmp <<'FEEDBACKKIT_BUILDERS_JSON'"))
    #expect(script.contains("chmod 600 builders.json.tmp && mv builders.json.tmp builders.json"))
    #expect(script.hasSuffix("\n" + config.json() + "\nFEEDBACKKIT_BUILDERS_JSON"))
}
