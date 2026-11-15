import XCTest

final class FeedbackMacSelectionUITests: XCTestCase {
    func testNativeSelectionOpensTheDirectLiveConversation() {
        let app = XCUIApplication()
        app.launchArguments += ["-liveWorkerEnabled", "NO"]
        app.launchEnvironment["FEEDBACKKIT_LIVE_FIXTURE"] = "status"
        app.launch()
        let row = app.buttons["feedback-thread"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.click()
        XCTAssertTrue(app.descendants(matching: .any)["feedback-cancel-pending"].firstMatch.waitForExistence(timeout: 5))
        app.buttons["feedback-new"].click()
        XCTAssertTrue(app.textViews["sessionReplyField"].waitForExistence(timeout: 5))
        row.click()
        XCTAssertTrue(app.descendants(matching: .any)["reply-ticks-2"].firstMatch.waitForExistence(timeout: 5))
    }
}
