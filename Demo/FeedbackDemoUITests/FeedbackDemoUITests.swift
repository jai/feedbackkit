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
        app.launch()
    }

    func testMainFlows() throws {
        XCTAssertEqual(app.staticTexts["demo-badge"].label, "Demo")
        // Owner: the agent working, a message that failed, and new feedback answered.
        XCTAssertTrue(text("An agent makes the change, tests it and ships a build.").waitForExistence(timeout: 10))
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
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
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
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appending(path: "\(name).png"))
        }
    }
}
