import AgentChatLive
import AgentChatKit

/// Shared-control identifiers, overridable by the host without replacing the renderers.
public struct FeedbackLiveIdentifiers {
    public var replies: (String) -> ReplyStatusIdentifiers
    public var queue: (LiveMessage) -> QueuedReplyIdentifiers
    public var question: LiveQuestionIdentifiers
    public var screenshots: SentScreenshotIdentifiers

    public init(
        replies: @escaping (String) -> ReplyStatusIdentifiers = { id in
            .init(retry: "feedback-retry-\(id)", cancel: "feedback-cancel-\(id)")
        },
        queue: @escaping (LiveMessage) -> QueuedReplyIdentifiers = { message in
            .init(edit: "feedback-edit-\(message.id)", remove: "feedback-remove-\(message.id)",
                  sendNow: "feedback-send-now-\(message.id)")
        },
        question: LiveQuestionIdentifiers = .init(question: .init(
            question: "feedback-question", answer: { "feedback-answer-\($0)" }
        ), text: "feedback-answer-text", submit: "feedback-answer-submit", decline: "feedback-answer-decline"),
        screenshots: SentScreenshotIdentifiers = .init(thumbnail: { message, index in
            "feedback-screenshot-\(message)-\(index)"
        })
    ) {
        self.replies = replies
        self.queue = queue
        self.question = question
        self.screenshots = screenshots
    }
}
