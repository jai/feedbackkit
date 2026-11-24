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

    /// What a row of the list is drawn on, and how it shows it is the open one.
    func rowGround(isSelected: Bool) -> some View {
        modifier(RowGround(isSelected: isSelected))
    }

    /// The unsent "New feedback" row, open at the head of the list. On the Mac it is no row of the list's own, so the
    /// list draws no selection for it: its fill runs the row's width and its words start where the rows' do. It was
    /// a bar the width of its words, further left than they are.
    func unsentRow() -> some View {
        modifier(UnsentRow())
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

/// The phone's rows are cards on the page, with a fill over the open one. The Mac's list fills a row edge to edge and
/// draws its own selection across it: there the card was a dark box behind the words alone, inside the row, and the
/// fill over it a second, smaller selection (Agent Pager, Jai, 2026-11-24: "list rows drawn as black cards on a grey
/// column"). So on the Mac a row draws neither, and only says it is selected.
private struct RowGround: ViewModifier {
    let isSelected: Bool
    @Environment(\.chatTheme) private var theme

    func body(content: Content) -> some View {
        #if os(macOS)
        content.accessibilityAddTraits(isSelected ? .isSelected : [])
        #else
        content
            .background(theme.groundCard)
            .selected(isSelected)
        #endif
    }
}

private struct UnsentRow: ViewModifier {
    @Environment(\.chatTheme) private var theme

    func body(content: Content) -> some View {
        #if os(macOS)
        content
            .listRowInsets(theme.spacing.rowInsets)
            .listRowBackground(theme.groundFill)
        #else
        content
        #endif
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
