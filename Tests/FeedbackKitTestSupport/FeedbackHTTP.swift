import DurableNetworking
import FeedbackKit
import Foundation

public final class FeedbackHTTP: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [String] = []
    public var requests: [String] { lock.withLock { seen } }

    public func answer(_ request: URLRequest) -> (Data, URLResponse) {
        let route = "\(request.httpMethod ?? "GET") \(request.url?.path() ?? "")"
        lock.withLock { seen.append(route) }
        let body = switch route {
        case "GET /feedback":
            #"{"threads": [{"id": "sesn_1", "title": "Bigger clock", "createdAt": "2026-11-05T09:00:00Z"}], "#
                + #""builderOnline": true}"#
        default:
            #"{"id": "sesn_1", "isWorking": true, "builderOnline": true, "messages": ["#
                + #"{"id": "e1", "role": "you", "text": "Bigger clock", "anchor": null}]}"#
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        return (Data(body.utf8), response)
    }
    public init() {}

    public var client: FeedbackClient {
        FeedbackClient(connection: URLFeedbackConnection(
            baseURL: { URL(string: "https://worker.example.com")! }, bearer: { "token" }, exchange: { self.answer($0) }
        ))
    }
}

public actor DirectHTTP: HTTPTransport, StreamingTransport {
    public private(set) var requests: [URLRequest] = []
    private var statuses: [Int]
    private let fails: Bool
    public init(statuses: [Int] = [], fails: Bool = false) { self.statuses = statuses; self.fails = fails }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        if fails { throw URLError(.networkConnectionLost) }
        let status = statuses.isEmpty ? 200 : statuses.removeFirst()
        let body = request.url!.path == "/v2/feedback" && request.httpMethod != "POST"
            ? #"{"threads":[],"builderOnline":true}"#
            : #"{"id":"chat-1","messages":[],"isWorking":false,"builderOnline":true}"#
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status,
                                                 httpVersion: nil, headerFields: nil)!)
    }
    public func open(_ request: URLRequest) async throws -> LineStream {
        throw URLError(.unsupportedURL)
    }
}

public actor TokenCalls {
    public init() {}

    public private(set) var calls: [Bool] = []
    public func token(_ renew: Bool) -> String {
        calls.append(renew)
        return renew ? "renewed-fixture" : "initial-fixture"
    }
}
