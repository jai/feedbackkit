import Foundation

/// How FeedbackKit reaches the Worker's `/feedback` routes: a GET whose answer is decoded, and a POST of a JSON body
/// whose answer is decoded. A host with its own Worker client conforms it (PRKit's `PRViewerClient` does, in
/// jai/prhub's `FeatureKit`); `URLFeedbackConnection` is the plain one.
public protocol FeedbackConnection: Sendable {
    func read<Answer: Decodable & Sendable>(_ path: String, as type: Answer.Type) async throws -> Answer
    func send<Body: Encodable & Sendable, Answer: Decodable & Sendable>(
        _ path: String, _ body: Body, as type: Answer.Type
    ) async throws -> Answer
}

/// A Worker refused a request: its status, and its own words when it gave some.
public struct FeedbackRefusal: LocalizedError, Equatable, Sendable {
    public let status: Int
    public let message: String?

    public var errorDescription: String? {
        message ?? "The Worker answered \(status)."
    }
}

/// The Worker over `URLSession`, with a bearer on each request: 15 s a request, and nothing repeated, so a message
/// never lands twice.
public struct URLFeedbackConnection: FeedbackConnection {
    let baseURL: @Sendable () -> URL?
    let bearer: @Sendable () async throws -> String
    let exchange: @Sendable (URLRequest) async throws -> (Data, URLResponse)

    public init(
        baseURL: @escaping @Sendable () -> URL?, bearer: @escaping @Sendable () async throws -> String,
        exchange: @escaping @Sendable (URLRequest) async throws -> (Data, URLResponse) = {
            try await URLSession.shared.data(for: $0)
        }
    ) {
        self.baseURL = baseURL
        self.bearer = bearer
        self.exchange = exchange
    }

    public func read<Answer: Decodable & Sendable>(_ path: String, as type: Answer.Type) async throws -> Answer {
        try await answer(request(path), as: type)
    }

    public func send<Body: Encodable & Sendable, Answer: Decodable & Sendable>(
        _ path: String, _ body: Body, as type: Answer.Type
    ) async throws -> Answer {
        var request = try await request(path)
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await answer(request, as: type)
    }

    private func request(_ path: String) async throws -> URLRequest {
        guard let base = baseURL() else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: base.appending(path: path), timeoutInterval: 15)
        request.setValue("Bearer \(try await bearer())", forHTTPHeaderField: "Authorization")
        return request
    }

    private func answer<Answer: Decodable>(_ request: URLRequest, as type: Answer.Type) async throws -> Answer {
        let (data, response) = try await exchange(request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let words = try? JSONDecoder().decode(Refusal.self, from: data)
            throw FeedbackRefusal(status: status, message: words?.error ?? words?.message)
        }
        return try JSONDecoder().decode(type, from: data)
    }

    private struct Refusal: Decodable {
        var error: String?
        var message: String?
    }
}
