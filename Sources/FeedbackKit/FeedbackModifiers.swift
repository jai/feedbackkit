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

    /// A row's words in the room its ground gives them, and VoiceOver told when it is the open one. The ground itself
    /// is the list row's (`FeedbackRowCard` on the phone and iPad, the list's own on the Mac).
    func rowGround(isSelected: Bool) -> some View {
        modifier(RowGround(isSelected: isSelected))
    }

    /// The unsent "New feedback" row, open at the head of the list. It is no row of the list's own, so the list draws
    /// neither ground nor selection for it: it has the rows' insets and the open row's ground across the list's width.
    /// It was a bar the width of its words, further left than they are.
    func unsentRow() -> some View {
        modifier(UnsentRow())
    }

    /// A note or a button of the list's that is no row of feedback: on the page, with no hairline around it.
    func onPage() -> some View {
        #if os(iOS)
        listRowBackground(Color.clear).listRowSeparator(.hidden)
        #else
        self
        #endif
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

/// What a row of the list is drawn on, on the phone and the iPad: the card, across the list's whole width and with
/// the fill over it when it is the open one, and a band of the page above and below as deep as the row's insets. It is
/// the list row's own background (`ChatThreadList.rowBackground`), so the row's insets and the list's chevron are on
/// it too. Behind the row's words alone it stopped short of both, and left them on the page: a grey block with a black
/// strip beside it (Jai, Agent Pager on the phone, 2026-11-24: "the coloring, the rows, the black bar on the right").
struct FeedbackRowCard: View {
    let isSelected: Bool
    @Environment(\.chatTheme) private var theme

    var body: some View {
        theme.groundCard
            .overlay {
                if isSelected {
                    theme.groundFill.transition(.opacity)
                }
            }
            .padding(.top, theme.spacing.rowInsets.top)
            .padding(.bottom, theme.spacing.rowInsets.bottom)
            .animation(ChatMotion.swap, value: isSelected)
    }
}

/// The Mac's list fills a row edge to edge and draws its own selection across it: a card there was a dark box behind
/// the words alone, inside the row, and a fill over it a second, smaller selection (Agent Pager, Jai, 2026-11-24:
/// "list rows drawn as black cards on a grey column"). So on the Mac a row only says it is selected. On the phone and
/// the iPad its ground is `FeedbackRowCard`, and the words keep clear of the card's edges.
private struct RowGround: ViewModifier {
    let isSelected: Bool
    @Environment(\.chatTheme) private var theme

    func body(content: Content) -> some View {
        #if os(macOS)
        content.accessibilityAddTraits(isSelected ? .isSelected : [])
        #else
        content
            .padding(.vertical, theme.spacing.sm)
            .accessibilityAddTraits(isSelected ? .isSelected : [])
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
            .listRowInsets(theme.spacing.rowInsets)
            .listRowBackground(FeedbackRowCard(isSelected: true))
            .listRowSeparator(.hidden)
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

/// Without the builder Mac polling, feedback waits in the queue. It says so, so a silent chat isn't a mystery.
struct BuilderNote: View {
    @Environment(\.chatTheme) private var theme
    var body: some View {
        Label {
            Text("The builder Mac is offline. Feedback waits until it is back.")
        } icon: {
            Image(systemName: theme.symbols.paused)
        }
        .font(theme.font(.caption))
        .foregroundStyle(theme.toneWaiting)
        .padding(.horizontal, ChatSpace.lg)
        .accessibilityIdentifier("feedback-builder-offline")
    }
}

extension ChatTheme {
    /// A read-only chat's row: its title in the quiet ink.
    var readOnly: ChatTheme {
        var theme = self
        theme.ink = inkQuiet
        return theme
    }
}
