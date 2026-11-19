import XCTest

/// Runs against FeedbackKit's direct configuration with the real ACP dev host, on iPhone and Mac.
final class LiveFeedbackUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-liveWorkerEnabled", "NO"]
    }

    func testDirectSharedReplyStatusCancelAndRetry() {
        launch("status")
        XCTAssertTrue(element("feedback-cancel-pending").waitForExistence(timeout: 5))
        let pending = text("This can still be cancelled")
        XCTAssertTrue(pending.waitForExistence(timeout: 5))
        activate(element("feedback-cancel-pending"))
        XCTAssertTrue(pending.waitForNonExistence(timeout: 5))
        let retry = element("feedback-retry-failed")
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        activate(retry)
        XCTAssertTrue(retry.waitForNonExistence(timeout: 5))
        XCTAssertTrue(text("Retry this reply").exists, "Retry retains the original bubble")
        capture("direct-live-status")
    }

    /// A chat started here goes live once its first message makes it a thread: the agent's answer arrives over ACP.
    func testANewDirectChatGoesLiveAndShowsTheAgentsAnswer() {
        launch("status", opening: false)
        activate(app.buttons["feedback-new"].firstMatch)
        let field = element("sessionReplyField")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        activate(field)
        field.typeText("Make the clock bigger")
        activate(element("sessionReplySend"))
        XCTAssertTrue(text("Live answer to your feedback").waitForExistence(timeout: 20),
                      "the new chat follows its live session and shows the agent's answer")
    }

    func testQueuedWordsAppearOnceAndSharedActionsReachACP() {
        launch("queue")
        // The conversation loads after the row opens it; count once it shows.
        XCTAssertTrue(element("feedback-edit-edit").waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(
            format: "label == %@ OR value == %@", "Edit these queued words", "Edit these queued words"
        )).count, 1)
        activate(element("feedback-edit-edit"))
        // A text view on iPhone, a text field on the Mac.
        let field = element("sessionReplyField")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        let draft = NSPredicate(format: "value CONTAINS %@", "Edit these queued words")
        let filled = XCTNSPredicateExpectation(predicate: draft, object: field)
        XCTAssertEqual(XCTWaiter.wait(for: [filled], timeout: 5), .completed)
        XCTAssertTrue(element("feedback-edit-edit").waitForNonExistence(timeout: 5))
        activate(element("feedback-remove-remove"))
        XCTAssertTrue(element("feedback-remove-remove").waitForNonExistence(timeout: 5))
        activate(element("feedback-send-now-now"))
        XCTAssertTrue(element("feedback-send-now-now").waitForNonExistence(timeout: 5))
        XCTAssertTrue(text("Send this reply now").exists)
        capture("direct-live-queue-actions")
    }

    func testQuestionButtonsSendAnAnswerThroughTheSharedAdapter() {
        launch("question")
        XCTAssertTrue(element("feedback-question").waitForExistence(timeout: 5))
        capture("direct-live-question")
        activate(element("feedback-answer-mac"))
        XCTAssertTrue(text("Answer received: mac").waitForExistence(timeout: 5))
        XCTAssertTrue(element("feedback-question").waitForNonExistence(timeout: 5))
    }

    func testFeedbackImageAdapterProvidesAScreenshotThumbnail() {
        launch("screenshots")
        let thumbnail = element("feedback-screenshot-picture-0")
        XCTAssertTrue(thumbnail.waitForExistence(timeout: 10))
        capture("direct-live-image-adapter")
    }

    private func launch(_ scenario: String, appearance: String = "light", opening: Bool = true) {
        app.terminate()
        app.launchEnvironment["FEEDBACKKIT_LIVE_FIXTURE"] = scenario
        if let host = ProcessInfo.processInfo.environment["FEEDBACKKIT_LIVE_SERVER"] {
            app.launchEnvironment["FEEDBACKKIT_LIVE_SERVER"] = host
        }
        app.launchEnvironment["FEEDBACKKIT_DEMO_APPEARANCE"] = appearance
        app.launch()
        let row = app.buttons["feedback-thread"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        capture("direct-live-list-\(scenario)-\(appearance)")
        if opening { activate(row) }
    }

    private func activate(_ element: XCUIElement) {
        #if os(macOS)
        element.click()
        #else
        element.tap()
        #endif
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
    private func text(_ value: String) -> XCUIElement {
        // A Mac StaticText holds its words in value, not label. On the Mac, reading every element's value timed out
        // ("Timed out while evaluating UI query"), so only static texts are read there.
        let predicate = NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", value, value)
        #if os(macOS)
        return app.staticTexts.matching(predicate).firstMatch
        #else
        return app.descendants(matching: .any).matching(predicate).firstMatch
        #endif
    }

    private func capture(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["FEEDBACKDEMO_SCREENSHOTS"] {
            do { try shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appending(path: "\(name).png")) }
            catch { XCTFail("Could not save UI capture") }
        }
    }
}
