import Foundation
import Security

/// The hidden setting: point the demo at a real Worker instead of the mock. Off unless someone turns it on. The URL is
/// a preference; the token stays in this device's Keychain, never in the repo.
struct LiveWorker: Equatable {
    static let enabledKey = "liveWorkerEnabled"
    static let urlKey = "liveWorkerURL"

    var isEnabled: Bool
    var url: String
    var token: String

    /// The root that serves `GET/POST /feedback`, when the setting is on and complete.
    var baseURL: URL? {
        guard isEnabled, !token.isEmpty, let url = URL(string: url.trimmingCharacters(in: .whitespaces)),
              url.scheme == "https" || url.scheme == "http", url.host() != nil
        else {
            return nil
        }
        return url
    }

    static func load(from defaults: UserDefaults = .standard) -> LiveWorker {
        LiveWorker(
            isEnabled: defaults.bool(forKey: enabledKey),
            url: defaults.string(forKey: urlKey) ?? "",
            token: TokenStore.read() ?? ""
        )
    }

    func save(to defaults: UserDefaults = .standard) {
        defaults.set(isEnabled, forKey: Self.enabledKey)
        defaults.set(url, forKey: Self.urlKey)
        TokenStore.write(token.isEmpty ? nil : token)
    }
}

/// The Worker's bearer, as a generic password in the Keychain.
enum TokenStore {
    private static var query: [String: Any] { [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.jaigovindani.feedbackkit.demo",
        kSecAttrAccount as String: "worker-token",
    ] }

    static func read() -> String? {
        var item: CFTypeRef?
        var search = query
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        guard SecItemCopyMatching(search as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ token: String?) {
        SecItemDelete(query as CFDictionary)
        guard let token else {
            return
        }
        var item = query
        item[kSecValueData as String] = Data(token.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(item as CFDictionary, nil)
    }
}
