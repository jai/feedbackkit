import XCTest

/// What a feedback chat shipped, on the Mac: the row's accessories and the conversation's header.
final class FeedbackMacShippedUITests: XCTestCase {
    func testRowAndHeaderSayWhatTheFeedbackShipped() {
        let app = XCUIApplication()
        app.launchArguments += ["-liveWorkerEnabled", "NO"]
        app.launch()
        // A row is one button: its accessories are in its label.
        let row = app.buttons.matching(identifier: "feedback-thread")
            .matching(NSPredicate(format: "label CONTAINS %@", "Settings should follow dark mode")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(row.label.contains("In Build 41"), row.label)
        XCTAssertFalse(row.label.contains("Checks"), "a release's chip carries no checks mark: \(row.label)")
        row.click()
        XCTAssertTrue(app.descendants(matching: .any)["feedback-shipped-header"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["feedback-shipped-header-commit-4f2c9a1"].firstMatch.exists)
    }
}
