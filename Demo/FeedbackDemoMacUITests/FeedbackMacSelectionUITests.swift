import XCTest

final class FeedbackMacSelectionUITests: XCTestCase {
    func testNativeSelectionOpensTheDirectLiveConversation() {
        let app = XCUIApplication()
        app.launchArguments += ["-liveWorkerEnabled", "NO"]
        app.launchEnvironment["FEEDBACKKIT_LIVE_FIXTURE"] = "status"
        app.launch()
        // The thread's own row: once New is open, its unsent "New feedback" row is a `feedback-thread` too, above it.
        let row = app.buttons.matching(identifier: "feedback-thread")
            .matching(NSPredicate(format: "label CONTAINS %@", "Direct live feedback")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.click()
        XCTAssertTrue(app.descendants(matching: .any)["feedback-cancel-pending"].firstMatch.waitForExistence(timeout: 5))
        app.buttons["feedback-new"].click()
        // A text field on the Mac.
        XCTAssertTrue(app.descendants(matching: .any)["sessionReplyField"].firstMatch.waitForExistence(timeout: 5))
        row.click()
        XCTAssertTrue(app.descendants(matching: .any)["reply-ticks-2"].firstMatch.waitForExistence(timeout: 5))
    }
}
