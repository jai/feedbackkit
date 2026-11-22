import UIKit
import XCTest

/// Walks the demo's main flows on iPhone: each role's chats, a send the mock agent answers, and the issue notice.
/// With `FEEDBACKDEMO_SCREENSHOTS` set (pass `TEST_RUNNER_FEEDBACKDEMO_SCREENSHOTS=<folder>`), it also writes the
/// README's screenshots there.
@MainActor
final class FeedbackDemoUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
        // The mock, whatever the hidden setting says on this simulator.
        app.launchArguments += ["-liveWorkerEnabled", "NO"]
        // No chat archived by an earlier run on this simulator.
        app.launchArguments += ["-FeedbackKit.archivedThreads", "()"]
        app.launch()
    }

    /// With no Archive of the host's, a row's long press archives the chat on this device; "Show archived (1)" lists
    /// it with Unarchive, which brings it back (#14).
    func testArchiveHidesAChatAndUnarchiveBringsItBack() throws {
        let title = "Export my notes as CSV"
        let row = self.row(title)
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.press(forDuration: 1.2)
        app.buttons["Archive"].firstMatch.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 5), "the archived chat left the list")
        let show = app.buttons["feedback-show-archived"]
        XCTAssertTrue(show.waitForExistence(timeout: 5))
        XCTAssertEqual(show.label, "Show archived (1)")
        show.tap()
        XCTAssertTrue(text(title).waitForExistence(timeout: 5))
        screenshot("archived-chats")
        app.buttons["feedback-unarchive"].firstMatch.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5), "the unarchived chat is back in the list")
        XCTAssertFalse(show.exists)
    }

    func testSharedRowsCallOnlyTheHostsConfirmedActions() throws {
        app.terminate()
        app.launchArguments += ["-DemoThreadControls"]
        app.launch()
        let title = "Make the sync button bigger, it's hard to hit"
        let row = app.staticTexts[title].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["About: Shared conversation row"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["Demo chip"].firstMatch.exists)
        screenshot("shared-thread-row")
        row.press(forDuration: 1.2)
        app.buttons["Archive"].firstMatch.tap()
        XCTAssertTrue(text("Archive hook: \(title)").waitForExistence(timeout: 5))
        row.press(forDuration: 1.2)
        app.buttons["Delete"].firstMatch.tap()
        cancelConfirmation()
        XCTAssertFalse(text("Delete hook:").exists)
        row.press(forDuration: 1.2)
        app.buttons["Delete"].firstMatch.tap()
        let confirmation = app.sheets.buttons["Delete"].firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        confirmation.tap()
        XCTAssertTrue(text("Delete hook: \(title)").waitForExistence(timeout: 5))
    }

    func testRowsAndChatsSayWhatTheFeedbackShipped() throws {
        // A row is one button: its accessories are in its label.
        let released = text("In Build 41")
        XCTAssertTrue(released.waitForExistence(timeout: 10), "the owner's shipped chat: its release")
        // A release ran its own tests, so its chip carries no checks mark (docs/api.md#shipped).
        XCTAssertFalse(released.label.contains("Checks"), released.label)
        screenshot("shipped-row")
        open("Settings should follow dark mode")
        XCTAssertTrue(app.descendants(matching: .any)["feedback-shipped-header"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(text("fix(settings): follow the system appearance").exists, "the commit, a link")
        XCTAssertTrue(app.descendants(matching: .any)["feedback-release-note"].firstMatch.exists,
                      "a released chat ends with the release that carries it")
        screenshot("shipped-header")
        back()
        role("Builder")
        XCTAssertTrue(text("PR open").waitForExistence(timeout: 5), "the builder's chat: its pull request is open")
        XCTAssertTrue(text("Pull request 57, open, Checks running").exists, "an open pull request shows its checks")
    }

    func testASendingMessageShowsItsScreenshotAndOpensIt() throws {
        app.terminate()
        // A send that takes seconds, so the message is seen while it is on its way.
        app.launchArguments += ["-DemoSlowSend"]
        app.launch()
        app.buttons["feedback-new"].tap()
        let field = app.textViews["sessionReplyField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("The badge is cut off")
        // A picture on the clipboard, pasted through the composer's Attach menu (the Paste control asks nothing).
        UIPasteboard.general.image = UIGraphicsImageRenderer(size: CGSize(width: 120, height: 200)).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 120, height: 200))
        }
        app.descendants(matching: .any)["composerAttach"].firstMatch.tap()
        app.descendants(matching: .any)["composerAttachPaste"].firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["composerAttachment"].firstMatch.waitForExistence(timeout: 5))
        app.buttons["sessionReplySend"].tap()
        let thumbnail = app.descendants(matching: .any)["feedback-screenshot-sending-0"].firstMatch
        XCTAssertTrue(thumbnail.waitForExistence(timeout: 3), "the screenshot shows in the message while it sends")
        screenshot("sending-screenshot")
        thumbnail.tap()
        let viewer = app.descendants(matching: .any)["sent-screenshot-viewer"].firstMatch
        XCTAssertTrue(viewer.waitForExistence(timeout: 5), "a tap opens it")
        app.descendants(matching: .any)["sent-screenshot-viewer-close"].firstMatch.tap()
        XCTAssertTrue(viewer.waitForNonExistence(timeout: 5))
    }

    func testMainFlows() throws {
        XCTAssertEqual(app.staticTexts["demo-badge"].label, "Demo")
        // Owner: the agent working, a message that failed, and new feedback answered.
        XCTAssertTrue(text("An agent makes the change, tests it and ships a build.").waitForExistence(timeout: 10))
        // Each request's row says where it stands: the agent building, and the shipped one released.
        XCTAssertTrue(app.descendants(matching: .any)["feedback-status-building"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["feedback-status-released"].exists)
        screenshot("owner-list")
        open("Make the sync button bigger, it's hard to hit")
        XCTAssertTrue(app.descendants(matching: .any)["feedback-working"].waitForExistence(timeout: 5))
        back()
        open("Export my notes as CSV")
        XCTAssertTrue(text("didn't reach the builder Mac").waitForExistence(timeout: 5))
        back()
        send("Add a search field to the notes list")
        XCTAssertTrue(text("build 58 is on TestFlight").waitForExistence(timeout: 20))
        screenshot("owner-chat")
        back()

        // Builder: the answer is a pull request.
        role("Builder")
        XCTAssertTrue(text("opens a pull request for an owner to merge").waitForExistence(timeout: 5))
        send("Make the note title bold")
        XCTAssertTrue(text("pull request #58").waitForExistence(timeout: 20))
        back()

        // Everyone else: a public issue, with the owner's comment from GitHub.
        role("Everyone else")
        open("The app crashes when I rotate on the map")
        XCTAssertTrue(text("issue #212").waitForExistence(timeout: 5))
        XCTAssertTrue(text("@jai").exists)
        screenshot("issue-chat")
        back()
        app.buttons["feedback-new"].tap()
        XCTAssertTrue(text("public GitHub issue on example/notes-app").waitForExistence(timeout: 5))

        // Switching back keeps what the owner sent.
        back()
        role("Owner")
        XCTAssertTrue(row("Add a search field to the notes list").waitForExistence(timeout: 5))
    }

    func testWorkerBadgeMatchesConnectionMode() {
        for (direct, label) in [("0", "Live"), ("1", "Direct")] {
            app.terminate()
            app.launchEnvironment["FEEDBACKKIT_DEMO_WORKER_URL"] = "http://127.0.0.1:1"
            app.launchEnvironment["FEEDBACKKIT_DEMO_WORKER_TOKEN"] = "ui-test-token"
            app.launchEnvironment["FEEDBACKKIT_DEMO_DIRECT"] = direct
            app.launch()

            let badge = app.staticTexts["demo-badge"]
            XCTAssertTrue(badge.waitForExistence(timeout: 10))
            XCTAssertEqual(badge.label, label)
        }
    }

    private func role(_ label: String) {
        app.segmentedControls["demo-role"].buttons[label].tap()
    }

    private func open(_ title: String) {
        let row = self.row(title)
        XCTAssertTrue(row.waitForExistence(timeout: 5), "No row \(title)")
        row.tap()
    }

    /// A list row: its title, then its age.
    private func row(_ title: String) -> XCUIElement {
        // The row's button holds its title as a text of its own on iOS 26, not as its label.
        app.buttons.containing(NSPredicate(format: "label == %@", title)).firstMatch
    }

    /// iOS 26 shows a row's confirmation dialog without a Cancel button; a tap on the dimmed screen outside it cancels.
    private func cancelConfirmation() {
        let cancel = app.buttons["Cancel"].firstMatch
        if cancel.waitForExistence(timeout: 2) {
            cancel.tap()
            return
        }
        let dialog = app.sheets.firstMatch
        let screen = app.windows.firstMatch.frame
        let frame = dialog.exists ? dialog.frame : CGRect(x: 0, y: screen.midY, width: screen.width, height: 0)
        let y = frame.minY > 200 ? (frame.minY - 60) / screen.height : (frame.maxY + 60) / screen.height
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: min(max(y, 0.15), 0.95))).tap()
        XCTAssertTrue(dialog.waitForNonExistence(timeout: 3), "the confirmation dialog stayed open")
    }

    private func back() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    private func send(_ words: String) {
        app.buttons["feedback-new"].tap()
        let field = app.textViews["sessionReplyField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(words)
        app.buttons["sessionReplySend"].tap()
    }

    private func text(_ part: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", part)).firstMatch
    }

    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["FEEDBACKDEMO_SCREENSHOTS"] {
            do {
                try shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appending(path: "\(name).png"))
            } catch {
                XCTFail("Could not keep the rendered demo: \(error)")
            }
        }
    }
}
