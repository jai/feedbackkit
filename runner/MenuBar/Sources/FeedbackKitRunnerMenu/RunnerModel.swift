import AppKit
import Observation
import RunnerMenuCore

/// What the menu shows, refreshed every 10 s over SSH, and its two actions.
@MainActor
@Observable
final class RunnerModel {
    /// The Mac mini's SSH alias; `defaults write com.jai.feedbackkit-runner-menu host <alias>` changes it.
    static let defaultHost = "jais-mac-mini"
    static let every: Duration = .seconds(10)

    private(set) var snapshot: Snapshot?
    private(set) var unreachable: String?
    private(set) var checkedAt: Double?
    private(set) var busy: String?
    private(set) var actionError: String?
    private let host: RunnerHost
    private var loop: Task<Void, Never>?

    init() {
        let alias = UserDefaults.standard.string(forKey: "host") ?? Self.defaultHost
        host = RunnerHost(ssh: SSH(host: alias))
        start()
    }

    var health: Health {
        Health.of(snapshot, unreachable: unreachable, now: Date().timeIntervalSince1970)
    }

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: Self.every)
            }
        }
    }

    func refresh() async {
        let (snapshot, unreachable) = await host.look()
        if let snapshot {
            self.snapshot = snapshot
        }
        self.unreachable = unreachable
        checkedAt = Date().timeIntervalSince1970
    }

    func restart() async {
        busy = "Restarting the runner…"
        actionError = await host.restart()
        busy = nil
        await refresh()
    }

    /// The log's last 2,000 lines in a file here, opened in the app that opens .log files (Console).
    func openLog() async {
        busy = "Fetching the log…"
        defer { busy = nil }
        switch await host.log() {
        case let .success(text):
            let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("FeedbackKitRunnerMenu", isDirectory: true)
            let file = folder.appendingPathComponent("feedbackkit-runner.log")
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                try Data(text.utf8).write(to: file)
                actionError = nil
                NSWorkspace.shared.open(file)
            } catch {
                actionError = "Could not save the log: \(error.localizedDescription)"
            }
        case let .failure(failure):
            actionError = "Could not fetch the log: \(failure.reason)"
        }
    }

    func open(_ thread: RunnerStatus.Thread) {
        if let url = threadLink(thread) {
            NSWorkspace.shared.open(url)
        }
    }
}
