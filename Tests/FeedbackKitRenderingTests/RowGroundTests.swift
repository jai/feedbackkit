#if os(macOS)
import AgentChatKit
import AppKit
@testable import FeedbackKit
import SwiftUI
import Testing

@MainActor
struct RowGroundTests {
    /// A row 100 pt wide on a white strip, its theme's card black and its selection's fill red, rendered at 1x.
    private func render(isSelected: Bool) throws -> NSBitmapImageRep {
        let view = Color.clear.frame(width: 100, height: 40)
            .rowGround(isSelected: isSelected)
            .background(Color.white)
            .environment(\.chatTheme, ChatTheme(groundCard: .black, groundFill: .red))
            .environment(\.colorScheme, .light)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        let image = try #require(renderer.cgImage)
        return NSBitmapImageRep(cgImage: image)
    }

    private func isWhite(_ color: NSColor?) -> Bool {
        guard let color = color?.usingColorSpace(.deviceRGB) else { return false }
        return color.redComponent > 0.99 && color.greenComponent > 0.99 && color.blueComponent > 0.99
    }

    /// The Mac's list draws the row and its selection: a card behind the words was a dark box inside the row.
    @Test func aMacRowDrawsNoCardOfItsOwn() throws {
        #expect(try isWhite(render(isSelected: false).colorAt(x: 50, y: 20)))
    }

    @Test func aSelectedMacRowDrawsNoFillOfItsOwn() throws {
        #expect(try isWhite(render(isSelected: true).colorAt(x: 50, y: 20)))
    }
}
#endif
