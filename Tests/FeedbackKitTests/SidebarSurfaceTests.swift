#if os(macOS)
import AppKit
import SwiftUI
import Testing
@testable import FeedbackKit

@MainActor
struct SidebarSurfaceTests {
    /// The list's column, 100 pt wide, on a white strip 140 pt wide, rendered at 1x.
    private func render() throws -> NSBitmapImageRep {
        let view = HStack(spacing: 0) {
            Color.clear.frame(width: 100, height: 40).sidebarSurface()
            Spacer(minLength: 0)
        }
        .frame(width: 140, height: 40)
        .background(Color.white)
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

    @Test func theColumnCastsNoShadowPastItsEdge() throws {
        let bitmap = try render()
        for x in 100..<140 {
            #expect(isWhite(bitmap.colorAt(x: x, y: 20)), "column \(x) is shaded")
        }
    }

    @Test func theSystemDividerDrawsTheColumnsTrailingEdge() throws {
        let bitmap = try render()
        let edge = try #require(bitmap.colorAt(x: 99, y: 20)?.usingColorSpace(.deviceRGB))
        let inside = try #require(bitmap.colorAt(x: 50, y: 20)?.usingColorSpace(.deviceRGB))
        #expect(edge != inside)
    }
}
#endif
