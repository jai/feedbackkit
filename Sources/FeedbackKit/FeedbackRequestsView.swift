import AgentChatKit
import SwiftUI
#if os(iOS)
import UIKit
#endif

/// Feature requests ("Feedback"), to an agent that makes the change, tests it and ships a build. Conversation first, as
/// Messages is: the screen lists the conversations, New starts one, and the first message makes it a thread that goes
/// on in place. Where the screen is narrow (a phone, Slide Over) a stack: the list, a conversation pushed over it. Where
/// it is wide (an iPad, the Mac) the list beside the conversation picked. A tab of its own: it brings its navigation.
public struct FeedbackRequestsView: View {
    @Environment(\.chatTheme) private var theme
    @State private var model: FeedbackRequestsModel
    private let conversation: ((FeedbackConversation) -> AnyView?)?
    private var liveIdentifiers = FeedbackLiveIdentifiers()
    private var rowLabel: ((FeedbackThread) -> AnyView?)?
    private var rowActions: (FeedbackThread) -> ChatThreadActions = { _ in ChatThreadActions() }
    /// The wide layout's open conversation.
    @State private var selection: FeedbackRoute?
    /// The narrow layout's conversations, pushed by value onto a stack of its own, so they stay open whatever is
    /// presented over them: More's controller dropped its pushes when a full-screen Files or Photos picker closed
    /// (iOS 27.2).
    @State private var path: [FeedbackRoute] = []
    /// The narrow layout's next new conversation: one route until its first message makes it a thread.
    @State private var newRoute = FeedbackRoute.new(UUID())
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// More's way back to its list, while the tab is under More (the phone, with more tabs than the bar holds). More's
    /// own bar is hidden then, so the stack's is the only one.
    @State private var more: MoreNavigation?
    #endif

    /// A model the host keeps, so drafts and open chats outlive the screen.
    public init(model: FeedbackRequestsModel) {
        _model = State(initialValue: model)
        conversation = nil
    }

    /// Keeps Feedback's list and first-message flow, then shows the host's coding-thread conversation once the
    /// runner names it and the host returns its view. The host moves the draft and attachments into that view's
    /// composer, and owns its delivery statuses, reply queue and Send now controls. Returning nil keeps Feedback.
    public init(
        model: FeedbackRequestsModel, conversation: @escaping (FeedbackConversation) -> AnyView?
    ) {
        _model = State(initialValue: model)
        self.conversation = conversation
    }

    public init(client: FeedbackClient) {
        self.init(model: FeedbackRequestsModel(client: client))
    }

    /// The same shared row as the host's other agent chats. Return nil while the host has no richer row data.
    /// Hooks define Archive/Delete for this host; FeedbackKit never deletes a coding session on its own.
    public func threadRows(
        label: @escaping (FeedbackThread) -> AnyView? = { _ in nil },
        actions: @escaping (FeedbackThread) -> ChatThreadActions = { _ in ChatThreadActions() }
    ) -> Self {
        var view = self
        view.rowLabel = label
        view.rowActions = actions
        return view
    }

    public func liveControls(identifiers: FeedbackLiveIdentifiers) -> Self {
        var view = self
        view.liveIdentifiers = identifiers
        return view
    }

    public var body: some View {
        layout
            .task { await model.refresh() }
    }

    @ViewBuilder private var layout: some View {
        #if os(iOS)
        if sizeClass == .regular {
            split
        } else {
            stack
                .background(MoreNavigationProbe { more = $0 })
        }
        #else
        split
        #endif
    }

    /// The list, a conversation pushed over it by its row, and New pushing an empty one: the one started and still
    /// empty, else a fresh one.
    private var stack: some View {
        NavigationStack(path: $path) {
            FeedbackListView(model: model, selected: nil, isStacked: true, customLabel: rowLabel, actions: rowActions) { _ in }
                .inlineNavigationTitle()
                .featureTitle("Feedback")
                .toolbar {
                    #if os(iOS)
                    if let more {
                        ToolbarItem(placement: .topBarLeading) {
                            Button(action: more.back) {
                                Image(systemName: theme.symbols.back)
                            }
                            .accessibilityLabel("More")
                            .accessibilityIdentifier("feedback-back-to-more")
                        }
                    }
                    #endif
                    ToolbarItem(placement: .primaryAction) {
                        Button("New feedback", systemImage: theme.symbols.compose) {
                            newRoute = model.compose(reusing: newRoute)
                            path = [newRoute]
                        }
                        .accessibilityIdentifier("feedback-new")
                    }
                }
                .navigationDestination(for: FeedbackRoute.self) { route in
                    FeedbackChatView(model: model, route: route, conversation: conversation, identifiers: liveIdentifiers)
                }
        }
    }

    private var split: some View {
        NavigationSplitView {
            FeedbackListView(model: model, selected: selection, routeSelection: $selection,
                             isStacked: false, customLabel: rowLabel, actions: rowActions) { route in
                withAnimation(ChatMotion.swap) { selection = route }
            }
            // The app's readable width is the window's; this column is narrower than it.
            .contentMargins(.horizontal, 0, for: .scrollContent)
            // Without a width of its own the Mac lays the list out at 140 points: rows wrap word by word and New
            // feedback, the column's toolbar item, falls into the toolbar's overflow menu.
            .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 420)
            .navigationTitle("Feedback")
            .sidebarSurface()
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("New feedback", systemImage: theme.symbols.compose) {
                        withAnimation(ChatMotion.fold) { selection = model.compose(reusing: selection) }
                    }
                    .accessibilityIdentifier("feedback-new")
                }
            }
        } detail: {
            NavigationStack {
                ZStack {
                    if let selection {
                        FeedbackChatView(model: model, route: selection, conversation: conversation, identifiers: liveIdentifiers)
                            .id(selection)
                            .transition(.opacity)
                    } else {
                        ContentUnavailableView(
                            "No feedback open", systemImage: theme.symbols.conversation,
                            description: Text("Pick a conversation, or start new feedback.")
                        )
                        .transition(.opacity)
                    }
                }
                .animation(ChatMotion.swap, value: selection)
            }
            // Measured again in this column, so the conversation centres in what the column has.
            .readableContentWidth()
        }
        .navigationSplitViewStyle(.balanced)
    }
}

extension View {
    /// A Feedback screen's title, on the phone in the bar's principal place in the app's own type.
    @ViewBuilder func featureTitle(_ title: String) -> some View {
        #if os(iOS)
        navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    FeedbackTitle(title: title)
                }
            }
        #else
        navigationTitle(title)
        #endif
    }
}

/// A Feedback screen's title in the bar, in the chat's type.
private struct FeedbackTitle: View {
    let title: String
    @Environment(\.chatTheme) private var theme

    var body: some View {
        Text(title)
            .font(theme.font(.subheadline).weight(.semibold))
            .lineLimit(1)
    }
}

/// The conversations, newest first; on a wide screen the open one is marked, and a new one not sent yet sits on top.
private struct FeedbackListView: View {
    @Environment(\.chatTheme) private var theme
    let model: FeedbackRequestsModel
    let selected: FeedbackRoute?
    var routeSelection: Binding<FeedbackRoute?>? = nil
    /// Pushed rows carry a chevron; rows beside their conversation are marked instead.
    let isStacked: Bool
    let customLabel: ((FeedbackThread) -> AnyView?)?
    let actions: (FeedbackThread) -> ChatThreadActions
    let open: (FeedbackRoute) -> Void
    @State private var showsArchived = false

    private var unsent: FeedbackRoute? {
        guard let selected, case .new = selected, model.thread(for: selected) == nil else {
            return nil
        }
        return selected
    }

    private var selectedThread: String? { selected.flatMap(model.thread(for:)) }

    private var threadSelection: Binding<String?>? {
        guard let routeSelection else { return nil }
        return Binding(
            get: { routeSelection.wrappedValue.flatMap(model.thread(for:)) },
            set: { routeSelection.wrappedValue = model.route(for: $0, keeping: routeSelection.wrappedValue) }
        )
    }

    var body: some View {
        ChatThreadList(items: model.visibleThreads, title: \.title, actions: rowActions,
                       selection: threadSelection, open: { open(.thread($0.id)) }) { thread in
            row(
                route: .thread(thread.id), title: thread.title,
                date: try? Date(thread.createdAt, strategy: .iso8601), isSelected: selectedThread == thread.id,
                thread: thread, custom: customLabel?(thread)
            )
        } header: {
            if !model.list.builderOnline {
                BuilderNote().padding(.bottom, ChatSpace.xs)
            }
            if let unsent {
                row(route: unsent, title: "New feedback", date: nil, isSelected: true)
                    .transition(.opacity)
            }
            if model.visibleThreads.isEmpty, unsent == nil {
                Text(model.list.notice ?? FeedbackList.agentNotice)
                    .font(theme.font(.footnote))
                    .foregroundStyle(theme.inkQuiet)
                    .padding(.horizontal, ChatSpace.lg)
                    .accessibilityIdentifier("feedback-empty")
            }
        } footer: {
            archivedSection
            if let error = model.error {
                Text(error)
                    .font(theme.font(.footnote))
                    .foregroundStyle(theme.toneBad)
                    .padding(.horizontal, ChatSpace.lg)
            }
        }
        .animation(ChatMotion.fold, value: model.list)
        .animation(ChatMotion.fold, value: model.archived)
        .animation(ChatMotion.fold, value: unsent)
        .refreshable { await model.refresh() }
    }

    /// The host's actions, with Archive on this device when the host brings none.
    private func rowActions(_ thread: FeedbackThread) -> ChatThreadActions {
        var actions = actions(thread)
        if actions.archive == nil {
            actions.archive = { [model] in
                model.archive(thread.id)
                return .success(())
            }
        }
        return actions
    }

    /// "Show archived (N)", and when open each archived chat with Unarchive.
    @ViewBuilder private var archivedSection: some View {
        let archived = model.archivedThreads
        if !archived.isEmpty {
            VStack(alignment: .leading, spacing: ChatSpace.xs) {
                Button(showsArchived ? "Hide archived" : "Show archived (\(archived.count))") {
                    withAnimation(ChatMotion.fold) { showsArchived.toggle() }
                }
                .chatTextStyle(.control)
                .accessibilityIdentifier("feedback-show-archived")
                if showsArchived {
                    ForEach(archived) { thread in
                        HStack(spacing: ChatSpace.sm) {
                            Text(thread.title)
                                .font(theme.font(.subheadline))
                                .foregroundStyle(theme.inkQuiet)
                                .lineLimit(1)
                            Spacer(minLength: ChatSpace.sm)
                            Button("Unarchive") {
                                withAnimation(ChatMotion.fold) { model.unarchive(thread.id) }
                            }
                            .chatTextStyle(.control)
                            .accessibilityIdentifier("feedback-unarchive")
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("feedback-archived-thread")
                    }
                }
            }
            .padding(.horizontal, ChatSpace.lg)
            .padding(.vertical, ChatSpace.sm)
        }
    }

    @ViewBuilder
    private func row(
        route: FeedbackRoute, title: String, date: Date?, isSelected: Bool, thread: FeedbackThread? = nil,
        custom: AnyView? = nil
    ) -> some View {
        if isStacked {
            NavigationLink(value: route) {
                rowLabel(title: title, date: date, isSelected: false, thread: thread, custom: custom)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("feedback-thread")
        } else {
            Button { open(route) } label: {
                rowLabel(title: title, date: date, isSelected: isSelected, thread: thread, custom: custom)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("feedback-thread")
        }
    }

    private func rowLabel(
        title: String, date: Date?, isSelected: Bool, thread: FeedbackThread?, custom: AnyView?
    ) -> some View {
        Group {
            if let custom {
                custom
            } else {
                ChatThreadRow(title: title) {
                    HStack(spacing: ChatSpace.sm) {
                        if let thread {
                            FeedbackRowStatus(thread: thread)
                        }
                        if let date {
                            Text(ThreadTimeFormat().age(date, now: .now))
                                .chatTextStyle(.meta)
                                .monospacedDigit()
                                .foregroundStyle(theme.inkQuiet)
                        }
                    }
                } chips: {
                    if let shipped = thread?.shipped {
                        FeedbackShippedChips(shipped: shipped)
                    }
                }
                // Greyed out: a reply can't reach its agent any more.
                .environment(\.chatTheme, thread?.ended == true ? theme.readOnly : theme)
            }
        }
        .background(theme.groundCard)
        .selected(isSelected && !isStacked)
        .contentShape(.rect)
    }
}

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
