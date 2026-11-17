import AgentChatKit
import SwiftUI

/// The agent's coding thread and the unsent content the host moves into its own reply composer on handoff.
@MainActor
public struct FeedbackConversation {
    public let thread: FeedbackAgentThread
    public let draft: Binding<String>
    public let attachments: ComposerAttachments
    /// What the feedback shipped, so the host can end its conversation with `FeedbackReleaseNote`.
    public let shipped: FeedbackShipped?
}

extension View {
    /// The phone's inline title; a Mac window has no navigation bar to size.
    func inlineNavigationTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }
}
