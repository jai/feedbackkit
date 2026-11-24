import UIKit
import XCTest

/// The list's rows as they are drawn on the phone, measured from the screen.
@MainActor
final class FeedbackRowSurfaceUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
        // The mock, whatever the hidden setting says on this simulator, and no chat archived by an earlier run.
        app.launchArguments += ["-liveWorkerEnabled", "NO", "-FeedbackKit.archivedThreads", "()"]
        app.launch()
    }

    /// A row is one surface across the list, in light and dark: its card runs from one edge of the screen to the
    /// other, under the row's insets and the list's chevron, with the page only between rows. The card was behind
    /// the row's words alone, so the insets and the chevron's column were the page's (Jai, Agent Pager on the phone,
    /// 2026-11-24: "the coloring, the rows, the black bar on the right, it's all fucked up").
    func testARowIsOneSurfaceFromEdgeToEdgeWithItsChevronOnIt() throws {
        // The simulator is left light, as the other tests expect it.
        defer { XCUIDevice.shared.appearance = .light }
        for appearance in [XCUIDevice.Appearance.light, .dark] {
            XCUIDevice.shared.appearance = appearance
            let title = app.staticTexts["Export my notes as CSV"].firstMatch
            XCTAssertTrue(title.waitForExistence(timeout: 10))
            let shot = try settled(dark: appearance == .dark, in: app.windows.firstMatch.frame)
            let attachment = XCTAttachment(screenshot: shot)
            attachment.name = "rows-\(appearance == .dark ? "dark" : "light")"
            attachment.lifetime = .keepAlways
            add(attachment)
            let words = title.frame
            let screen = app.windows.firstMatch.frame
            // Just past the title, between it and the row's status: the row's own ground, before and after.
            let card = try colour(shot, at: CGPoint(x: words.maxX + 3, y: words.midY), in: screen)
            let places = [
                ("the leading inset", CGPoint(x: screen.minX + 2, y: words.midY)),
                ("the trailing edge, past the chevron", CGPoint(x: screen.maxX - 2, y: words.midY)),
            ]
            for (name, point) in places {
                let found = try colour(shot, at: point, in: screen)
                XCTAssertTrue(same(found, card), "\(appearance): \(name) is \(found), the row's card is \(card)")
            }
            // Up the leading edge from the words, the card ends and the page shows: the rows are apart.
            let above = try (1...40).map { step in
                try colour(shot, at: CGPoint(x: screen.minX + 2, y: words.minY - CGFloat(step)), in: screen)
            }
            XCTAssertTrue(above.contains { !same($0, card) }, "\(appearance): no page shows between the rows")
        }
    }

    /// The screen once it has taken the appearance asked for: its top corner, the ground behind the bars, is dark or
    /// light. A loaded simulator takes longer than a fixed second to change.
    private func settled(dark: Bool, in screen: CGRect) throws -> XCUIScreenshot {
        let end = Date().addingTimeInterval(30)
        while true {
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
            let shot = XCUIScreen.main.screenshot()
            let corner = try colour(shot, at: CGPoint(x: screen.minX + 2, y: screen.minY + 2), in: screen)
            let isDark = corner.reduce(0, +) < 3 * 128
            if isDark == dark || Date() > end {
                XCTAssertEqual(isDark, dark, "the screen never turned \(dark ? "dark" : "light")")
                return shot
            }
        }
    }

    /// The screen's colour at a point of the window, as red, green and blue from 0 to 255.
    private func colour(_ shot: XCUIScreenshot, at point: CGPoint, in screen: CGRect) throws -> [Int] {
        let image = try XCTUnwrap(shot.image.cgImage)
        let scale = CGFloat(image.width) / screen.width
        var pixel = [UInt8](repeating: 0, count: 4)
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try XCTUnwrap(CGContext(
            data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        // Draw the screenshot so the pixel asked for lands on the context's one pixel; its origin is bottom left.
        let across = (point.x * scale).rounded(.down)
        let down = (point.y * scale).rounded(.down)
        context.draw(image, in: CGRect(x: -across, y: down - CGFloat(image.height - 1),
                                       width: CGFloat(image.width), height: CGFloat(image.height)))
        return pixel.prefix(3).map(Int.init)
    }

    private func same(_ one: [Int], _ other: [Int]) -> Bool {
        zip(one, other).allSatisfy { abs($0 - $1) <= 3 }
    }
}
