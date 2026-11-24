import Foundation

/// Where a `FeedbackRequestsModel` keeps its list between launches, so Feedback opens on the requests it last had and
/// reads again behind them, never on an empty list (Jai, 2026-11-24: "I never want to see this loading screen we must
/// cache aggressively locally"). The model made with a client alone keeps to `standard()`; a host with more than one
/// account names a place for each, and clears it when the account leaves.
public struct FeedbackKeep: Sendable {
    let load: @Sendable () -> Data?
    let save: @Sendable (Data) -> Void
    let remove: @Sendable () -> Void

    /// Keeps to something else than a file: a test's own memory.
    public init(
        load: @escaping @Sendable () -> Data?, save: @escaping @Sendable (Data) -> Void,
        remove: @escaping @Sendable () -> Void = {}
    ) {
        self.load = load
        self.save = save
        self.remove = remove
    }

    /// Keeps to one file, made with its folder at the first save.
    public init(file: URL) {
        self.init(
            load: { try? Data(contentsOf: file) },
            save: { data in
                let manager = FileManager.default
                try? manager.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                #if os(iOS)
                try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                #else
                try? data.write(to: file, options: .atomic)
                #endif
            },
            remove: { try? FileManager.default.removeItem(at: file) }
        )
    }

    /// In Application Support, which the system never clears: `FeedbackKit/<name>/list.json`, under the app's own
    /// folder on the Mac. Nil where the app has no such folder.
    public static func standard(named name: String = "default") -> FeedbackKeep? {
        guard var folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        #if os(macOS)
        if let bundle = Bundle.main.bundleIdentifier {
            folder.append(path: bundle, directoryHint: .isDirectory)
        }
        #endif
        folder.append(path: "FeedbackKit", directoryHint: .isDirectory)
        folder.append(path: name, directoryHint: .isDirectory)
        return FeedbackKeep(file: folder.appending(path: "list.json"))
    }

    /// What is kept goes: an account signed out.
    public func clear() {
        remove()
    }

    func list() -> FeedbackList? {
        load().flatMap { try? JSONDecoder().decode(FeedbackList.self, from: $0) }
    }

    func keep(_ list: FeedbackList) {
        guard let data = try? JSONEncoder().encode(list) else {
            return
        }
        save(data)
    }
}
