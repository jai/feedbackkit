import DurableNetworking
import FeedbackKit
import Foundation

public final class FeedbackHTTP: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [String] = []
    private var list: String?
    private var listStatus = 200
    private var chats: [String]
    public var requests: [String] { lock.withLock { seen } }

    public func answer(_ request: URLRequest) -> (Data, URLResponse) {
        let route = "\(request.httpMethod ?? "GET") \(request.url?.path() ?? "")"
        let (body, status): (String, Int) = lock.withLock {
            seen.append(route)
            if route == "GET /feedback" {
                return (list ?? #"{"threads": [{"id": "sesn_1", "title": "Bigger clock", "#
                    + #""createdAt": "2026-11-05T09:00:00Z"}], "builderOnline": true}"#, listStatus)
            }
            let chat = chats.count > 1 ? chats.removeFirst() : chats.first
            return (chat ?? #"{"id": "sesn_1", "isWorking": true, "builderOnline": true, "messages": ["#
                + #"{"id": "e1", "role": "you", "text": "Bigger clock", "anchor": null}]}"#, 200)
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (Data(body.utf8), response)
    }

    /// `list`: what `GET /feedback` answers, instead of one plain row. `chats`: what the chat routes answer, in turn;
    /// the last one from then on.
    public init(list: String? = nil, chats: [String] = []) {
        self.list = list
        self.chats = chats
    }

    /// What `GET /feedback` answers from now on, and with which status.
    public func lists(_ list: String?, status: Int = 200) {
        lock.withLock {
            self.list = list ?? self.list
            listStatus = status
        }
    }

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
    private let list: String
    /// `list`: what `GET /v2/feedback` answers, instead of no chats.
    public init(statuses: [Int] = [], fails: Bool = false, list: String = #"{"threads":[],"builderOnline":true}"#) {
        self.statuses = statuses
        self.fails = fails
        self.list = list
    }

    /// How many times the list was read, and how many times a chat was.
    public var listReads: Int { requests.count { $0.url!.path == "/v2/feedback" && $0.httpMethod != "POST" } }
    public var chatReads: Int { requests.count { $0.url!.path != "/v2/feedback" } }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        if fails { throw URLError(.networkConnectionLost) }
        let status = statuses.isEmpty ? 200 : statuses.removeFirst()
        let body = request.url!.path == "/v2/feedback" && request.httpMethod != "POST"
            ? list
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
