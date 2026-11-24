import SwiftUI
#if os(macOS)
import AppKit
#endif

// How many feedback chats need the sender, for a badge on the host's tab, row or sidebar item. A chat needs them while
// its agent asked a question they have not answered: the rows that say Needs you for a question. A reply that is no
// question does not count: nothing records what the sender has read, so such a count would never go down.

extension FeedbackThread {
    /// The agent asked the sender a question that has no answer yet, and a reply can still reach it.
    public var needsAttention: Bool {
        !ended && agent?.state == .needsYou && agent?.asks == true
    }

    /// As the Worker lists it once the sender answered: their message waits for the agent's next turn.
    func answered() -> FeedbackThread {
        FeedbackThread(
            id: id, title: title, createdAt: createdAt, thread: thread,
            agent: FeedbackThreadAgent(state: .working, activity: nil, isQueued: true, asks: false),
            shipped: shipped, ended: ended
        )
    }

    /// As the Worker lists it once its agent asked: Needs you, for a question.
    func asked() -> FeedbackThread {
        FeedbackThread(
            id: id, title: title, createdAt: createdAt, thread: thread,
            agent: FeedbackThreadAgent(state: .needsYou, activity: nil, isQueued: false, asks: true),
            shipped: shipped, ended: ended
        )
    }
}

extension FeedbackRequestsModel {
    /// How many chats need the sender: each has a question of its agent's with no answer yet. Chats archived on this
    /// device and chats that ended are left out, as the list shows no Needs you for them. Observable, and there
    /// without the Feedback screen: from the list the device kept at once, then from each read (`refresh`,
    /// `received`, an open chat's changes). Give it to `.badge`, which shows nothing for zero.
    public var needsAttentionCount: Int {
        visibleThreads.count(where: \.needsAttention)
    }

    /// A push from FeedbackKit's Worker arrived or was tapped (`FeedbackPush(userInfo:)`): a question counts at once,
    /// and the list is read again. A silent delivery push changes no count and reads nothing.
    public func received(_ push: FeedbackPush) async {
        guard push.kind != .status else {
            return
        }
        if push.asks {
            change(push.chat) { $0.needsAttention ? nil : $0.asked() }
        }
        await refresh()
    }
}

extension View {
    /// Keeps `model.needsAttentionCount` right while the app is in front, whatever screen shows: the list is read at
    /// launch, each time the app comes to the foreground, and every `interval` after that (nil: never again until the
    /// next foreground). Put it on the app's root view. A model that changes (another account, another path) is read
    /// at once.
    public func feedbackAttention(
        _ model: FeedbackRequestsModel?, every interval: Duration? = .seconds(300)
    ) -> some View {
        modifier(FeedbackAttentionReads(model: model, interval: interval))
    }

    /// The count of chats that need the sender as this view's badge: a tab's label, a list row, a sidebar item.
    /// Nothing shows for zero or no model. A `Tab` takes the count itself: `.badge(model.needsAttentionCount)`.
    public func feedbackBadge(_ model: FeedbackRequestsModel?) -> some View {
        badge(model?.needsAttentionCount ?? 0)
    }
}

private struct FeedbackAttentionReads: ViewModifier {
    let model: FeedbackRequestsModel?
    let interval: Duration?
    @Environment(\.scenePhase) private var scenePhase
    @State private var app = AppActivity()
    /// A Mac app stays "in front" while another app has the keyboard: each return to it reads again.
    @State private var activations = 0

    private struct Key: Hashable {
        let model: ObjectIdentifier?
        let isForeground: Bool
        let activations: Int
    }

    /// As a chat decides it (`FeedbackChatView`): outside a SwiftUI app scene the scene's phase never says active.
    private var isForeground: Bool { scenePhase == .active || app.isActive }

    func body(content: Content) -> some View {
        content
            .task(id: Key(model: model.map(ObjectIdentifier.init), isForeground: isForeground, activations: activations)) {
                guard let model, isForeground else {
                    return
                }
                await model.refresh()
                guard let interval else {
                    return
                }
                while !Task.isCancelled {
                    do {
                        try await Task.sleep(for: interval)
                    } catch {
                        return
                    }
                    await model.refresh()
                }
            }
            #if os(macOS)
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                activations += 1
            }
            #endif
    }
}
