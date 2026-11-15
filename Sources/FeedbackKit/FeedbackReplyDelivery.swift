import AgentChatKit

/// Feedback's transport states mapped once into the shared chat's delivery presentation.
extension FeedbackMessageDelivery {
    var replyState: ReplyDeliveryState {
        switch self {
        case .pending: .pending()
        case .delivering: .delivering
        case .delivered: .delivered
        case .failed: .failed
        case .unknown: .other
        }
    }

    var statusText: String {
        switch self {
        case .pending: "Waiting for the builder"
        case .delivering: "Sending to the agent"
        case .delivered: "Delivered"
        case .failed: "Message did not reach the agent"
        case .unknown: "Waiting for delivery confirmation"
        }
    }
}
