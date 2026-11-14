import AgentChatKit
import SwiftUI

/// The agent's coding thread and the unsent content the host moves into its own reply composer on handoff.
@MainActor
public struct FeatureConversation {
    public let thread: FeatureAgentThread
    public let draft: Binding<String>
    public let attachments: ComposerAttachments
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
