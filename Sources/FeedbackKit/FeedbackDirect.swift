import AgentChatKit
import AgentChatLive
import DurableNetworking
import Foundation

/// Explicit Worker origin/root, before `/v2`. The app backend issues this user's FeedbackKit token.
/// `renew` is true only after a 401. Legacy/proxy clients retain their existing constructors.
public struct FeedbackDirect: Sendable {
    public typealias Token = @Sendable (_ renew: Bool) async throws -> String
    public typealias LiveFactory = @MainActor @Sendable (LiveEndpoint) -> LiveChatModel

    public let baseURL: URL
    public let token: Token
    let http: any HTTPTransport
    let images: any HTTPTransport
    let liveFactory: LiveFactory
    /// Optional host override. By default the live model retries the same message and client reference.
    public var retry: LiveChatControls.Retry?

    public init(
        baseURL: URL, token: @escaping Token,
        http: any HTTPTransport = URLSessionTransport(policy: .quick),
        streams: any StreamingTransport = URLSessionStreamingTransport(quietLimit: 40),
        images: (any HTTPTransport)? = nil,
        liveFactory: LiveFactory? = nil, retry: LiveChatControls.Retry? = nil
    ) {
        self.baseURL = baseURL
        self.token = token
        self.http = http
        self.images = images ?? URLSessionTransport(policy: .quick)
        self.liveFactory = liveFactory ?? { endpoint in
            LiveChatModel(endpoint: endpoint, http: http, streams: streams)
        }
        self.retry = retry
    }

    @MainActor func makeLive(_ session: String) -> LiveChatModel {
        liveFactory(LiveEndpoint(acp: baseURL.appending(path: "v2/acp"), session: session, bearer: token))
    }

    /// The same bearer only for the Worker's own origin. External signed HTTPS resources need no bearer.
    /// The supplied DurableNetworking transport owns the session policy.
    public func loadScreenshot(_ attachment: LiveAttachment) async -> Result<Data, ChatActionError> {
        do {
            let request = try screenshotRequest(attachment.uri)
            let sameOrigin = Self.sameOrigin(request.url!, baseURL)
            let data = try await authorized(request, authenticated: sameOrigin) { request in
                try await images.send(request)
            }
            return .success(data)
        } catch {
            return .failure(ChatActionError("Could not load this screenshot."))
        }
    }

    func screenshotRequest(_ uri: String) throws -> URLRequest {
        guard let url = URL(string: uri, relativeTo: baseURL.appending(path: "v2/acp"))?.absoluteURL,
              url.scheme?.lowercased() == "https", url.user == nil, url.password == nil else {
            throw URLError(.unsupportedURL)
        }
        return URLRequest(url: url, timeoutInterval: 15)
    }

    static func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
        lhs.scheme?.lowercased() == rhs.scheme?.lowercased()
            && lhs.host?.lowercased() == rhs.host?.lowercased()
            && (lhs.port ?? 443) == (rhs.port ?? 443)
    }

    /// No retry for unknown network failure. One explicit 401 retries the exact request with a renewed token.
    func authorized(
        _ request: URLRequest, authenticated: Bool = true,
        exchange: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
    ) async throws -> Data {
        var request = request
        if authenticated { request.setValue("Bearer \(try await token(false))", forHTTPHeaderField: "Authorization") }
        var (data, response) = try await exchange(request)
        if authenticated, response.statusCode == 401 {
            request.setValue("Bearer \(try await token(true))", forHTTPHeaderField: "Authorization")
            (data, response) = try await exchange(request)
        }
        guard (200..<300).contains(response.statusCode) else {
            // Server/transport descriptions can contain signed URLs. Keep direct-path errors safe to display.
            throw FeedbackRefusal(status: response.statusCode, message: nil)
        }
        return data
    }
}

struct DirectFeedbackConnection: FeedbackConnection {
    let configuration: FeedbackDirect

    func read<Answer: Decodable & Sendable>(_ path: String, as type: Answer.Type) async throws -> Answer {
        try await answer(request(path), as: type)
    }

    func send<Body: Encodable & Sendable, Answer: Decodable & Sendable>(
        _ path: String, _ body: Body, as type: Answer.Type
    ) async throws -> Answer {
        var request = try request(path)
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await answer(request, as: type)
    }

    private func request(_ path: String) throws -> URLRequest {
        guard configuration.baseURL.scheme?.lowercased() == "https" else { throw URLError(.unsupportedURL) }
        return URLRequest(url: configuration.baseURL.appending(path: "v2").appending(path: path), timeoutInterval: 15)
    }

    private func answer<Answer: Decodable>(_ request: URLRequest, as type: Answer.Type) async throws -> Answer {
        let data = try await configuration.authorized(request, exchange: configuration.http.send)
        return try JSONDecoder().decode(type, from: data)
    }
}
