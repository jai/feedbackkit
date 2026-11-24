import DurableNetworking
import Foundation

/// A push from FeedbackKit's Worker (docs/api.md#pushes), read from a notification's `userInfo`: which chat it is
/// about and why. The host's notification delegate reads one from a tapped notification and opens its chat
/// (`FeedbackRequestsView.opening`).
public struct FeedbackPush: Equatable, Sendable {
    public enum Kind: String, Sendable {
        /// An agent took the chat.
        case taken
        /// The agent wrote something new.
        case reply
        /// A message's delivery changed; silent.
        case status
    }

    /// The payload's key for FeedbackKit's data.
    public static let key = "feedbackkit"

    public let chat: String
    /// The app's key on the Worker; nil when the payload names none.
    public let app: String?
    /// Nil for a kind this build does not know: still a push about `chat`.
    public let kind: Kind?
    /// The reply is a question the agent asked the sender.
    public let asks: Bool

    public init(chat: String, app: String? = nil, kind: Kind? = .reply, asks: Bool = false) {
        self.chat = chat
        self.app = app
        self.kind = kind
        self.asks = asks
    }

    /// Nil for any notification that is not FeedbackKit's, or names no usable chat.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let data = userInfo[Self.key] as? [AnyHashable: Any], let chat = data["chat"] as? String,
              Self.isChatID(chat)
        else {
            return nil
        }
        self.init(
            chat: chat, app: data["app"] as? String, kind: (data["kind"] as? String).flatMap(Kind.init),
            asks: data["asks"] as? Bool ?? false
        )
    }

    /// The id goes into a URL path: only what the Worker could have made.
    static func isChatID(_ chat: String) -> Bool {
        !chat.isEmpty && chat.count <= 200 && chat.unicodeScalars.allSatisfy { scalar in
            scalar.isASCII && (CharacterSet.alphanumerics.contains(scalar) || "_-:.".unicodeScalars.contains(scalar))
        }
    }
}

/// A chat to open: a tapped push's (`FeedbackPush.chat`), or a link's. A new request for the same chat opens it again.
public struct FeedbackOpenRequest: Equatable, Sendable {
    public let chat: String
    public let id: UUID

    public init(chat: String, id: UUID = UUID()) {
        self.chat = chat
        self.id = id
    }
}

extension FeedbackRequestsView {
    /// Opens a chat over the list: a tapped push's (`FeedbackPush`). Each new request opens its chat once, and a view
    /// made while the host still passes one starts on that chat, so the host clears it when Feedback leaves the
    /// screen. Nil opens nothing.
    public func opening(_ request: FeedbackOpenRequest?) -> Self {
        var view = self
        view.openRequest = request
        return view
    }
}

/// Which APNs host takes the device's token: a TestFlight or App Store build's is production, a development build's
/// sandbox.
public enum FeedbackPushEnvironment: String, Sendable {
    case production
    case sandbox
}

extension FeedbackDirect {
    private struct Device: Encodable {
        let token: String
        let environment: String
    }

    /// `POST /v2/devices`: this device gets the pushes of the signed-in sender's chats. `token` is the APNs device
    /// token in hex. Register it at each launch and whenever the system gives a new one; a token moves to whoever
    /// registered it last. Until a device is registered the Worker pushes nothing.
    public func registerDevice(token: String, environment: FeedbackPushEnvironment) async throws {
        var request = try devicesRequest()
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(Device(token: token, environment: environment.rawValue))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try await authorized(request, exchange: http.send)
    }

    /// `DELETE /v2/devices/{token}`: the device gets no more pushes, as at sign-out.
    public func unregisterDevice(token: String) async throws {
        var request = try devicesRequest(token.lowercased())
        request.httpMethod = "DELETE"
        _ = try await authorized(request, exchange: http.send)
    }

    private func devicesRequest(_ token: String? = nil) throws -> URLRequest {
        guard baseURL.scheme?.lowercased() == "https" else { throw URLError(.unsupportedURL) }
        var url = baseURL.appending(path: "v2/devices")
        if let token {
            guard token.count >= 64, token.count <= 200, token.allSatisfy(\.isHexDigit) else {
                throw URLError(.badURL)
            }
            url = url.appending(path: token)
        }
        return URLRequest(url: url, timeoutInterval: 15)
    }
}
