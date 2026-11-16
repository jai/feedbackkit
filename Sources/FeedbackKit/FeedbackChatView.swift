import AgentChatKit
import AgentChatLive
import SwiftUI

/// One conversation: what Jai said and what the agent did with it, with a box to say more. A new one is empty, with
/// the box ready; its first message makes the thread, and the conversation goes on here.
struct FeedbackChatView: View {
    @Environment(\.chatTheme) private var theme
    @Environment(\.scenePhase) private var scenePhase
    @State private var app = AppActivity()
    @Bindable var model: FeedbackRequestsModel
    let route: FeedbackRoute
    let conversation: ((FeedbackConversation) -> AnyView?)?
    var identifiers = FeedbackLiveIdentifiers()
    @FocusState private var isWriting: Bool

    private var box: String { route.box }
    private var thread: String? { model.thread(for: route) }
    private var chat: FeedbackChat? { model.chat(for: route) }
    private var live: LiveChatModel? { model.live(for: route) }
    private var isNew: Bool { thread == nil && !model.isSending(box) }
    /// Legacy messages stay visible until delivered; the host also decides whether its thread is ready to draw.
    var hostedConversation: AnyView? {
        guard let conversation, let chat, let thread = chat.thread,
              !model.isSending(box), !chat.hasUndeliveredMessages
        else {
            return nil
        }
        return conversation(FeedbackConversation(
            thread: thread, draft: model.binding(for: box), attachments: model.attachments(for: box)
        ))
    }

    /// Once the first message created the feedback chat, the host's coding thread receives every follow-up.
    var awaitsAgentThread: Bool { conversation != nil && thread != nil }

    private var messages: [FeedbackChat.Message] {
        let sent = chat?.messages ?? []
        guard let pending = model.pending[box], !sent.contains(where: { $0.isJai && $0.text == pending.text })
        else {
            return sent
        }
        return sent + [FeedbackChat.Message(id: Self.pendingID, role: "you", text: pending.text, anchor: nil)]
    }

    private static let pendingID = "__feedbackkit_sending__"

    private func screenshots(_ message: FeedbackChat.Message) -> Int {
        message.id == Self.pendingID ? model.pending[box]?.screenshots ?? 0 : chat?.screenshots[message.id] ?? 0
    }

    /// In front of the person: its scene says so, or the app is active. Outside a SwiftUI app scene (a hosting
    /// controller in a UIKit or React Native app) `scenePhase` stays `.background`, and the app's state decides (#9).
    private var isForeground: Bool { scenePhase == .active || app.isActive }

    /// Whether Jai was reading the end of the chat when he last scrolled it: a new message then keeps him there.
    @State private var readsEnd = true
    @State private var screenshotViewing = SentScreenshotViewing()

    var body: some View {
        let hosted = hostedConversation
        Group {
            if let hosted {
                hosted
            } else {
                feedbackConversation
                    .inlineNavigationTitle()
                    .featureTitle(model.title(for: route) ?? "New feedback")
            }
        }
        .background(theme.groundPage)
        .presentsSentScreenshots(screenshotViewing, identifiers: identifiers.screenshots)
        .task(id: thread) {
            if thread == nil {
                isWriting = true
            }
        }
        .task(id: FollowKey(
            thread: thread,
            isLive: model.client.direct == nil && (chat?.isWorking == true || model.isSending(box)),
            isHosted: hosted != nil, foreground: isForeground
        )) {
            await model.follow(route, mode: conversation == nil ? .whileWorking : .untilHandoff,
                               isForeground: isForeground, isHosted: hosted != nil)
        }
        .task { await model.seedScreenshot(in: box) }
    }

    private var feedbackConversation: some View {
        ChatView(
            messages: displayedMessages,
            sent: displayedMessages.count(where: { $0.role == .mine }), readsEnd: $readsEnd, focus: $isWriting,
            extras: { message in
                if message.id == Self.pendingID, !pendingImages.isEmpty {
                    // The screenshots going out with this message, as the sent ones show: tap to view.
                    SentScreenshotStrip(key: "sending", identifiers: identifiers.screenshots) { [pendingImages] _ in
                        .success(pendingImages)
                    }
                } else if let live, let controls = model.controls(for: route),
                          live.chat.message(message.id) != nil {
                    LiveReplyStatus(controls: controls, messageID: message.id,
                                    identifiers: identifiers.replies(message.id), retry: model.client.direct?.retry)
                    if let direct = model.client.direct {
                        LiveScreenshotStrip(live: live, messageID: message.id,
                                            identifiers: identifiers.screenshots, load: direct.loadScreenshot)
                    }
                } else if message.role == .mine, let state = delivery(for: message.id) {
                    SentReplyStatus(state: state.replyState, text: state.statusText, about: message.text)
                }
            },
            header: {
                if let shipped = chat?.shipped {
                    FeedbackShippedSection(shipped: shipped)
                }
                if chat?.builderOnline == false || (isNew && !model.list.builderOnline) {
                    BuilderNote()
                }
                if messages.isEmpty {
                    Text(model.list.notice ?? FeedbackList.agentNotice)
                        .font(theme.font(.footnote))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, theme.spacing.lg)
                        .transition(.opacity)
                        .accessibilityIdentifier("feedback-new-hint")
                }
            },
            footer: {
                if let controls = model.controls(for: route) {
                    LiveQuestionView(controls: controls, identifiers: identifiers.question)
                }
                if let live, live.phase == .reconnecting {
                    Text("Reconnecting…").chatTextStyle(.meta).accessibilityIdentifier("feedback-reconnecting")
                } else if let live, case .stopped = live.phase {
                    Text("Live feedback is unavailable.").chatTextStyle(.meta)
                        .accessibilityIdentifier("feedback-live-stopped")
                }
                status
                    .animation(ChatMotion.fold, value: chat?.isWorking)
            },
            composer: { composer }
        )
    }

    private var displayedMessages: [ChatMessage] {
        if let live, live.chat.cursor != nil || live.chat.state != nil {
            var rows = live.conversationMessages.map { row in
                var row = row
                if let message = live.chat.message(row.id) {
                    row.hasExtras = message.kind == .user || !message.attachments.isEmpty
                    if message.kind == .user, message.status != nil {
                        row.ticks = nil // LiveReplyStatus owns the ticks, once.
                        if message.ticks != nil { row.date = nil }
                    }
                }
                return row
            }
            if let pending = model.pending[box],
               !live.chat.messages.contains(where: { $0.clientRef == pending.clientRef }) {
                rows.append(pendingRow(pending))
            }
            return rows
        }
        return messages.map {
            if $0.id == Self.pendingID, let pending = model.pending[box] { return pendingRow(pending) }
            return ChatMessage(id: $0.id, role: $0.isJai ? .mine : .theirs,
                               text: ScreenshotLine.bubbleText($0.text, screenshots: screenshots($0)),
                               hasExtras: $0.isJai && delivery(for: $0.id) != nil)
        }
    }

    /// The message on its way: its words, and its screenshots as thumbnails under them (the count when there are none
    /// to draw).
    private func pendingRow(_ pending: PendingMessage) -> ChatMessage {
        pending.images.isEmpty
            ? ChatMessage(id: Self.pendingID, role: .mine,
                          text: ScreenshotLine.bubbleText(pending.text, screenshots: pending.screenshots))
            : ChatMessage(id: Self.pendingID, role: .mine,
                          text: pending.text.isEmpty
                              ? ScreenshotLine.bubbleText(pending.text, screenshots: pending.screenshots) : pending.text,
                          hasExtras: true)
    }

    private var pendingImages: [Data] { model.pending[box]?.images ?? [] }

    private func delivery(for messageID: String) -> FeedbackMessageDelivery? {
        if messageID == Self.pendingID { return nil }
        return chat?.delivery[messageID]
    }

    private struct FollowKey: Hashable {
        let thread: String?
        let isLive: Bool
        let isHosted: Bool
        let foreground: Bool
    }

    @ViewBuilder private var status: some View {
        if showsWorking {
            HStack(spacing: theme.spacing.sm) {
                ProgressView().controlSize(.small)
                Text(activity)
                    .font(theme.font(.caption))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, theme.spacing.md)
            .accessibilityIdentifier("feedback-working")
        } else if let problem = handoffProblem {
            Text(problem)
                .font(theme.font(.footnote))
                .foregroundStyle(theme.toneBad)
                .padding(.horizontal, theme.spacing.md)
        } else if let cents = chat?.costCents, !messages.isEmpty {
            Text("\((Double(cents) / 100).formatted(.currency(code: "USD"))) so far, of $10")
                .font(theme.font(.caption))
                .foregroundStyle(.secondary)
                .padding(.horizontal, theme.spacing.md)
        } else {
            Color.clear.frame(height: 0)
        }
    }

    private var showsWorking: Bool {
        if awaitsAgentThread {
            return handoffProblem == nil
        }
        return chat?.isWorking == true || model.isSending(box)
    }

    var handoffProblem: String? {
        if let problem = chat?.problem {
            return problem
        }
        if awaitsAgentThread, chat?.delivery.values.contains(.failed) == true {
            return "An earlier message did not reach the agent. Start new feedback to continue."
        }
        return nil
    }

    private var activity: String {
        if awaitsAgentThread {
            return chat?.thread == nil ? "Starting the agent…" : "Waiting for the agent thread"
        }
        return chat?.builderOnline == false ? "Waiting for the builder Mac" : chat?.activity ?? "Thinking"
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: theme.spacing.xs) {
            if let controls = model.controls(for: route) {
                LiveQueuedReplies(controls: controls, draft: model.binding(for: box), identifiers: identifiers.queue)
            }
            if let error = model.error {
                Text(error)
                    .font(theme.font(.footnote))
                    .foregroundStyle(theme.toneBad)
                    .chatBarWidth()
                    .transition(.opacity)
            }
            SessionComposer(
                draft: model.binding(for: box), isSending: model.isSending(box) || awaitsAgentThread, send: send,
                placeholder: thread == nil ? "What should change?" : "Reply", focused: $isWriting,
                attachments: model.attachments(for: box)
            )
        }
        .animation(ChatMotion.fold, value: model.error)
        .composerBar()
    }

    private func send() {
        guard !awaitsAgentThread else {
            return
        }
        isWriting = false
        Task {
            if conversation != nil {
                await model.sendFirstMessage(route)
            } else {
                await model.send(route)
            }
        }
    }
}

extension FeedbackList {
    /// What sending does when the Worker gives no notice: the owner's coding agent.
    static let agentNotice = "Say what to change in the app. An agent makes the change, tests it and ships a build."
}
