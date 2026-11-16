import XCTest

/// Archive on the Mac: a row's right-click archives the chat on this Mac, and Unarchive brings it back (#14).
final class FeedbackMacArchiveUITests: XCTestCase {
    func testArchiveHidesAChatAndUnarchiveBringsItBack() {
        let app = XCUIApplication()
        app.launchArguments += ["-liveWorkerEnabled", "NO", "-FeedbackKit.archivedThreads", "()"]
        app.launch()
        let title = "Export my notes as CSV"
        let row = app.buttons.matching(identifier: "feedback-thread")
            .matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.rightClick()
        app.menuItems["Archive"].firstMatch.click()
        XCTAssertTrue(row.waitForNonExistence(timeout: 5), "the archived chat left the list")
        let show = app.buttons["feedback-show-archived"]
        XCTAssertTrue(show.waitForExistence(timeout: 5))
        show.click()
        let unarchive = app.buttons["feedback-unarchive"].firstMatch
        XCTAssertTrue(unarchive.waitForExistence(timeout: 5))
        unarchive.click()
        XCTAssertTrue(row.waitForExistence(timeout: 5), "the unarchived chat is back in the list")
    }
}
