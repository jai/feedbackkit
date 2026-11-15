import AgentChatKit
import SwiftUI
#if os(iOS)
import UIKit
#endif

extension View {
    /// The list's column beside a conversation: the page's ground, and the system's divider at its edge.
    func sidebarSurface() -> some View {
        modifier(SidebarSurface())
    }

    /// A row that is open beside the list: the fill over it, and VoiceOver says it is selected.
    func selected(_ isSelected: Bool) -> some View {
        modifier(SelectedRow(isSelected: isSelected))
    }

    /// On a wide iPad, keeps every scroll view under it to the width of an iPad in portrait, centred.
    func readableContentWidth() -> some View {
        #if os(iOS)
        modifier(ReadableContentWidth())
        #else
        self
        #endif
    }
}

private struct SidebarSurface: ViewModifier {
    @Environment(\.chatTheme) private var theme

    func body(content: Content) -> some View {
        content
            .background {
                theme.groundPage
                    .ignoresSafeArea()
            }
            // The system owns the divider's thickness and contrast.
            .overlay(alignment: .trailing) {
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    Divider()
                }
                .ignoresSafeArea()
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
    }
}

private struct SelectedRow: ViewModifier {
    let isSelected: Bool
    @Environment(\.chatTheme) private var theme

    func body(content: Content) -> some View {
        content
            .overlay {
                if isSelected {
                    theme.groundFill
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }
            }
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            .animation(ChatMotion.swap, value: isSelected)
    }
}

#if os(iOS)
private struct ReadableContentWidth: ViewModifier {
    @State private var margin: CGFloat = 0

    func body(content: Content) -> some View {
        if UIDevice.current.userInterfaceIdiom == .pad {
            content
                .contentMargins(.horizontal, margin > 0 ? margin : nil, for: .scrollContent)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                    margin = max(0, (width - ChatStyle.barMaxWidth) / 2)
                }
        } else {
            content
        }
    }
}
#endif
