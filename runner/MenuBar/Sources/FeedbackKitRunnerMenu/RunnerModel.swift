import AppKit
import Observation
import RunnerMenuCore

/// What the menu shows, refreshed every 10 s over SSH, and its actions. It also looks hourly for a newer menu app.
@MainActor
@Observable
final class RunnerModel {
    /// The Mac mini's SSH alias; `defaults write com.jai.feedbackkit-runner-menu host <alias>` changes it.
    static let defaultHost = "jais-mac-mini"
    static let every: Duration = .seconds(10)
    static let dismissedKey = "dismissedFailures"
    static let installLog = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/feedbackkit-runner-menu-install.log")

    private(set) var snapshot: Snapshot?
    private(set) var unreachable: String?
    private(set) var checkedAt: Double?
    private(set) var busy: String?
    private(set) var actionError: String?
    private(set) var dismissed: Dismissed
    /// This app's version and commit, from its Info.plist (bundle.sh stamps them); 0.0.0 for a build without a tag.
    let version: String
    let commit: String?
    /// A newer published menu app, when there is one.
    private(set) var update: Version?
    private(set) var updateError: String?
    private var updateCheckedAt: Double?
    private let host: RunnerHost
    private var loop: Task<Void, Never>?

    init() {
        let alias = UserDefaults.standard.string(forKey: "host") ?? Self.defaultHost
        host = RunnerHost(ssh: SSH(host: alias))
        dismissed = Dismissed(UserDefaults.standard.dictionary(forKey: Self.dismissedKey) as? [String: Double] ?? [:])
        version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? Version.dev.description
        commit = Bundle.main.object(forInfoDictionaryKey: "FKCommit") as? String
        start()
    }

    var health: Health {
        Health.of(snapshot, unreachable: unreachable, dismissed: dismissed.keys, now: Date().timeIntervalSince1970)
    }

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                await self?.checkForUpdate(after: MenuRelease.checkEvery)
                try? await Task.sleep(for: Self.every)
            }
        }
    }

    func refresh() async {
        let (snapshot, unreachable) = await host.look()
        if let snapshot {
            self.snapshot = snapshot
            if let status = snapshot.status {
                keep(dismissed.pruned(by: status, now: Date().timeIntervalSince1970))
            }
        }
        self.unreachable = unreachable
        checkedAt = Date().timeIntervalSince1970
    }

    /// Refresh by hand: also looks for a newer menu app when the last look is 5 minutes old.
    func refreshByHand() async {
        await refresh()
        await checkForUpdate(after: MenuRelease.checkOnRefreshAfter)
    }

    /// The failed message stops counting as a problem; its chat stays in the list.
    func dismiss(_ key: String) {
        var dismissed = dismissed
        dismissed.add(key, now: Date().timeIntervalSince1970)
        keep(dismissed)
    }

    private func keep(_ dismissed: Dismissed) {
        guard dismissed != self.dismissed else { return }
        self.dismissed = dismissed
        UserDefaults.standard.set(dismissed.at, forKey: Self.dismissedKey)
    }

    /// Looks for a newer menu app when the last look is at least `after` seconds old. A failed look only sets
    /// `updateError`.
    func checkForUpdate(after: Double) async {
        let now = Date().timeIntervalSince1970
        guard MenuRelease.due(lastCheck: updateCheckedAt, now: now, after: after) else { return }
        updateCheckedAt = now
        do {
            update = try await MenuRelease.fetch().newer(than: version)
            updateError = nil
        } catch {
            updateError = error.localizedDescription
        }
    }

    /// Runs install.sh, which replaces the app and restarts it, so on success this app is stopped before it returns.
    func installUpdate() async {
        guard let update else { return }
        busy = "Installing \(update)…"
        let failure = await runDetached(MenuRelease.installScript, log: Self.installLog)
        busy = nil
        actionError = failure.map { "Install failed (\($0)); see \(Self.installLog.path)" }
    }

    /// Writes builders.json on the Mac mini, then looks again.
    func setBuilders(_ config: BuildersConfig) async {
        busy = "Saving the builders…"
        actionError = await host.write(config).map { "Could not save the builders: \($0)" }
        busy = nil
        await refresh()
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
