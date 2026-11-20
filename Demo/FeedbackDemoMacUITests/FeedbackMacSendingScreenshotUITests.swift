import AppKit
import XCTest

/// A screenshot sent with feedback shows in the message while it is on its way, on the Mac.
final class FeedbackMacSendingScreenshotUITests: XCTestCase {
    func testASendingMessageShowsItsScreenshot() {
        let app = XCUIApplication()
        // A send that takes seconds, so the message is seen while it is on its way.
        app.launchArguments += ["-liveWorkerEnabled", "NO", "-DemoSlowSend"]
        app.launch()
        app.buttons["feedback-new"].click()
        let field = app.descendants(matching: .any)["sessionReplyField"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.click()
        field.typeText("The badge is cut off")

        // A picture on the clipboard, pasted through the composer's Attach menu.
        let picture = NSImage(size: NSSize(width: 120, height: 200), flipped: false) { rect in
            NSColor.systemTeal.setFill()
            rect.fill()
            return true
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects([picture])
        app.descendants(matching: .any)["composerAttach"].firstMatch.click()
        app.descendants(matching: .any)["composerAttachPaste"].firstMatch.click()
        XCTAssertTrue(app.descendants(matching: .any)["composerAttachment"].firstMatch.waitForExistence(timeout: 5))

        app.buttons["sessionReplySend"].click()
        let thumbnail = app.descendants(matching: .any)["feedback-screenshot-sending-0"].firstMatch
        XCTAssertTrue(thumbnail.waitForExistence(timeout: 3), "the screenshot shows in the message while it sends")
        XCTAssertTrue(thumbnail.waitForNonExistence(timeout: 25), "once sent, the chat's own message replaces it")
    }
}
