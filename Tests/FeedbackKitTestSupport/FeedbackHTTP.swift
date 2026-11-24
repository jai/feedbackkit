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
    private let chat: String
    private let media: Data
    private var tickets = 0
    /// `list`: what `GET /v2/feedback` answers, instead of no chats. `chat`: what a chat's routes and a send answer,
    /// instead of a chat with no messages. `media`: the bytes of a message's attachment.
    public init(
        statuses: [Int] = [], fails: Bool = false, list: String = #"{"threads":[],"builderOnline":true}"#,
        chat: String = #"{"id":"chat-1","messages":[],"isWorking":false,"builderOnline":true}"#, media: Data = Data()
    ) {
        self.statuses = statuses
        self.fails = fails
        self.list = list
        self.chat = chat
        self.media = media
    }

    /// The requests of one method to one path, in order.
    public func requests(_ method: String, _ path: String) -> [URLRequest] {
        requests.filter { ($0.httpMethod ?? "GET") == method && $0.url!.path == path }
    }

    /// How many times the list was read, and how many times a chat was.
    public var listReads: Int { requests.count { $0.url!.path == "/v2/feedback" && $0.httpMethod != "POST" } }
    public var chatReads: Int { requests.count { $0.url!.path != "/v2/feedback" } }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        if fails { throw URLError(.networkConnectionLost) }
        let status = statuses.isEmpty ? 200 : statuses.removeFirst()
        let path = request.url!.path
        let body: Data
        if path == "/v2/feedback", request.httpMethod != "POST" {
            body = Data(list.utf8)
        } else if path == "/v2/feedback/uploads" {
            // A video's upload ticket (docs/api.md#videos): where to PUT it, and the uri its message names.
            tickets += 1
            body = Data(#"{"uploadUrl":"/v2/feedback/uploads/up_\#(tickets)","uri":"/v2/feedback/uploads/up_\#(tickets)","#
                .utf8) + Data(#""headers":{"Content-Type":"video/quicktime"}}"#.utf8)
        } else if path.hasPrefix("/v2/feedback/uploads/") {
            body = Data(#"{"ok":true}"#.utf8)
        } else if path.contains("/images/") {
            body = media
        } else {
            body = Data(chat.utf8)
        }
        return (body, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
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
