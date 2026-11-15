import FeedbackKit
import Foundation
import Observation

/// Which Feedback the demo shows: one mock Worker and model per role, kept so drafts and sent chats survive a switch,
/// or the real Worker when the hidden setting is on.
@MainActor
@Observable
final class DemoState {
    var role: DemoRole = .owner
    private(set) var live: LiveWorker
    private let models: [DemoRole: FeedbackRequestsModel]
    private var liveModel: FeedbackRequestsModel?

    init(live: LiveWorker = .load()) {
        self.live = live
        models = Dictionary(uniqueKeysWithValues: DemoRole.allCases.map { role in
            (role, FeedbackRequestsModel(client: FeedbackClient(connection: DemoWorker(role: role))))
        })
        liveModel = Self.model(for: live)
    }

    /// The live Worker's root while the setting is on.
    var liveURL: URL? { live.baseURL }

    /// What `FeedbackRequestsView` shows.
    var model: FeedbackRequestsModel { liveModel ?? models[role]! }

    /// A new key gives `FeedbackRequestsView` a fresh screen.
    var modelKey: String { live.baseURL.map { "live-\($0.absoluteString)" } ?? role.rawValue }

    func apply(_ settings: LiveWorker) {
        settings.save()
        live = settings
        liveModel = Self.model(for: settings)
    }

    /// The real Worker over `URLSession`, with the token as its bearer.
    private static func model(for live: LiveWorker) -> FeedbackRequestsModel? {
        guard let url = live.baseURL else {
            return nil
        }
        let token = live.token
        if live.isDirect {
            let source = TokenSource(backend: url, signIn: token)
            return FeedbackRequestsModel(client: FeedbackClient(connection: DirectConnection(source: source)))
        }
        return FeedbackRequestsModel(client: FeedbackClient(baseURL: { url }, bearer: { token }))
    }
}
