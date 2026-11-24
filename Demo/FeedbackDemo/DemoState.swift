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
    private var fixtureModel: FeedbackRequestsModel?
    var directError: String?
    private var liveModel: FeedbackRequestsModel?

    init(live: LiveWorker = .load()) {
        self.live = live
        // Each launch of the demo starts with no list kept from the one before: its UI tests count on what they see.
        FeedbackKeep.standard()?.clear()
        models = Dictionary(uniqueKeysWithValues: DemoRole.allCases.map { role in
            (role, FeedbackRequestsModel(client: FeedbackClient(connection: DemoWorker(role: role))))
        })
        liveModel = Self.model(for: live)
        if let scenario = ProcessInfo.processInfo.environment["FEEDBACKKIT_LIVE_FIXTURE"] {
            fixtureModel = DemoLiveFixture.model(scenario: scenario)
        }
    }

    /// The live Worker's root while the setting is on.
    var liveURL: URL? { live.baseURL }

    var needsDirectConnection: Bool {
        fixtureModel == nil && live.isDirect && live.baseURL != nil && liveModel == nil
    }

    /// What `FeedbackRequestsView` shows.
    var model: FeedbackRequestsModel { fixtureModel ?? liveModel ?? models[role]! }

    /// A new key gives `FeedbackRequestsView` a fresh screen.
    var modelKey: String { live.baseURL.map { "live-\($0.absoluteString)-\(liveModel != nil)" } ?? role.rawValue }

    func apply(_ settings: LiveWorker) {
        settings.save()
        live = settings
        liveModel = Self.model(for: settings)
        directError = nil
    }

    /// Resolve the explicit `/v2` root supplied by the sample token endpoint, then use the public direct API.
    func resolveDirect() async {
        guard fixtureModel == nil, live.isDirect, let backend = live.baseURL else { return }
        let settings = live
        let source = TokenSource(backend: backend, signIn: settings.token)
        do {
            let issued = try await source.token()
            guard issued.root.lastPathComponent == "v2" else { throw URLError(.badURL) }
            guard live == settings else { return }
            liveModel = FeedbackRequestsModel(client: FeedbackClient(direct: FeedbackDirect(
                baseURL: issued.root.deletingLastPathComponent(), token: { renew in
                    try await source.token(renew: renew).token
                }
            )))
        } catch {
            guard live == settings else { return }
            directError = "Could not connect to direct feedback. Check the Worker setting."
        }
    }

    /// The real Worker over `URLSession`, with the token as its bearer.
    private static func model(for live: LiveWorker) -> FeedbackRequestsModel? {
        guard let url = live.baseURL else {
            return nil
        }
        let token = live.token
        if live.isDirect { return nil }
        return FeedbackRequestsModel(client: FeedbackClient(baseURL: { url }, bearer: { token }))
    }
}
