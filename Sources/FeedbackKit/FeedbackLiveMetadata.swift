import AgentChatLive
import Foundation

/// FeedbackKit's extension boundary. Unknown host fields stay out of the generic live model.
struct FeedbackLiveMetadata: Decodable {
    var builderOnline: Bool?
    var thread: FeedbackAgentThread?
    var costCents: Int?

    private enum CodingKeys: CodingKey { case builderOnline, thread, costCents }

    init(from decoder: any Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        builderOnline = try fields.decodeIfPresent(Bool.self, forKey: .builderOnline)
        thread = try FeedbackAgentThread.decodeNamed(fields, forKey: .thread)
        costCents = try fields.decodeIfPresent(Int.self, forKey: .costCents)
    }

    static func decode(_ extra: JSONValue?) -> Self? {
        guard let data = try? extra?.data() else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
}

extension FeedbackChat {
    init(live: LiveChat, id: String, bootstrap: FeedbackChat?) {
        let metadata = FeedbackLiveMetadata.decode(live.state?.extra)
        let visible = live.messages.filter { $0.status != .removed }
        self.init(
            id: id,
            messages: visible.filter { $0.kind != .tool }.map {
                Message(id: $0.id, role: $0.kind == .user ? "you" : "agent", text: $0.text)
            },
            isWorking: live.state?.working ?? false,
            activity: live.state?.activity, problem: live.state?.problem,
            costCents: metadata?.costCents ?? bootstrap?.costCents,
            builderOnline: metadata?.builderOnline ?? bootstrap?.builderOnline ?? true,
            screenshots: Dictionary(uniqueKeysWithValues: visible.map { ($0.id, $0.attachments.count) }),
            // An explicit absent/blank live reference revokes an older bootstrap reference.
            thread: live.state == nil ? bootstrap?.thread : metadata?.thread,
            delivery: Dictionary(uniqueKeysWithValues: visible.filter { $0.kind == .user }.map {
                let status: FeedbackMessageDelivery = switch $0.status {
                case .pending, .queued: .pending
                case .delivering: .delivering
                case .delivered: .delivered
                case .failed: .failed
                default: .unknown
                }
                return ($0.id, status)
            })
        )
    }
}
