import FeedbackKit
import Foundation

/// FeedbackKit's direct path (docs/api.md#direct): the app's backend issues a short-lived FeedbackKit token, here the
/// sample backend's `POST /feedback/token` (sample-worker/), and the app talks to FeedbackKit's Worker itself with it.
actor TokenSource {
    private struct Answer: Decodable {
        let token: String
        let expiresAt: String
        let feedbackkit: String
    }

    private let backend: URL
    private let signIn: String
    private var current: (token: String, root: URL, until: Date)?

    init(backend: URL, signIn: String) {
        self.backend = backend
        self.signIn = signIn
    }

    /// A token with more than a minute left, and FeedbackKit's `/v2` root it is for; a new one when it runs low.
    func token(renew: Bool = false) async throws -> (token: String, root: URL) {
        if renew { current = nil }
        if let current, current.until.timeIntervalSinceNow > 60 {
            return (current.token, current.root)
        }
        var request = URLRequest(url: backend.appending(path: "feedback/token"), timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("Bearer \(signIn)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.userAuthenticationRequired)
        }
        let answer = try JSONDecoder().decode(Answer.self, from: data)
        guard let root = URL(string: answer.feedbackkit) else {
            throw URLError(.badURL)
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let until = formatter.date(from: answer.expiresAt) ?? Date().addingTimeInterval(10 * 60)
        current = (answer.token, root, until)
        return (answer.token, root)
    }
}

/// FeedbackKit's Worker with a token from `TokenSource`, asked for before each request.
struct DirectConnection: FeedbackConnection {
    let source: TokenSource

    func read<Answer: Decodable & Sendable>(_ path: String, as type: Answer.Type) async throws -> Answer {
        try await connection().read(path, as: type)
    }

    func send<Body: Encodable & Sendable, Answer: Decodable & Sendable>(
        _ path: String, _ body: Body, as type: Answer.Type
    ) async throws -> Answer {
        try await connection().send(path, body, as: type)
    }

    private func connection() async throws -> URLFeedbackConnection {
        let (token, root) = try await source.token()
        return URLFeedbackConnection(baseURL: { root }, bearer: { token })
    }
}
