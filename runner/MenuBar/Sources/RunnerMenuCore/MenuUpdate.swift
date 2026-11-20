import Darwin
import Foundation

/// A release version, `major.minor.patch`, compared by number. A leading `v` and anything after a `-` or `+` are
/// dropped: `v0.12.0` is 0.12.0.
public struct Version: Sendable, Equatable, Comparable, CustomStringConvertible {
    public var major: Int
    public var minor: Int
    public var patch: Int

    public init(major: Int, minor: Int, patch: Int) {
        self.major = major
        self.minor = minor
        self.patch = patch
    }

    public init?(_ text: String) {
        var core = Substring(text.trimmingCharacters(in: .whitespaces))
        if core.first == "v" { core = core.dropFirst() }
        core = core.prefix { $0 != "-" && $0 != "+" }
        let parts = core.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        let numbers = parts.compactMap { part in part.allSatisfy(\.isASCII) ? Int(part) : nil }
        guard numbers.count == 3, numbers.allSatisfy({ $0 >= 0 }) else { return nil }
        self.init(major: numbers[0], minor: numbers[1], patch: numbers[2])
    }

    /// A build made without a release tag (a lint or local build) says 0.0.0.
    public static let dev = Version(major: 0, minor: 0, patch: 0)

    public static func < (lhs: Version, rhs: Version) -> Bool {
        (lhs.major, lhs.minor, lhs.patch) < (rhs.major, rhs.minor, rhs.patch)
    }

    public var description: String { "\(major).\(minor).\(patch)" }
}

/// FeedbackKitRunner.json, which each release publishes beside the menu app's zip in the `runner-menu` prerelease.
public struct MenuRelease: Decodable, Sendable, Equatable {
    public var version: String
    public var commit: String?
    public var tag: String?

    public static let url = URL(string: "https://github.com/jai/feedbackkit/releases/download/runner-menu/FeedbackKitRunner.json")!
    /// install.sh from main, as README.md installs it; it restarts the app on a new build.
    public static let installScript = "curl -fsSL https://raw.githubusercontent.com/jai/feedbackkit/main/runner/MenuBar/install.sh | sh"
    /// Look again after an hour, and on Refresh after 5 minutes.
    public static let checkEvery: Double = 3600
    public static let checkOnRefreshAfter: Double = 300

    public static func decode(_ data: Data) throws -> MenuRelease {
        try JSONDecoder().decode(MenuRelease.self, from: data)
    }

    /// The published release, from GitHub's download link: no API, no token.
    public static func fetch(session: URLSession = .shared) async throws -> MenuRelease {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            throw URLError(.badServerResponse, userInfo: [NSLocalizedDescriptionKey: "answered \(http.statusCode)"])
        }
        return try decode(data)
    }

    /// Whether to look again: never looked, or the last look is at least `after` seconds old.
    public static func due(lastCheck: Double?, now: Double, after: Double) -> Bool {
        guard let lastCheck else { return true }
        return now - lastCheck >= after
    }

    /// This release's version when it is newer than `installed`. A dev build (0.0.0) or an unreadable version never
    /// has an update.
    public func newer(than installed: String) -> Version? {
        guard let installed = Version(installed), installed != .dev, let published = Version(version) else { return nil }
        return published > installed ? published : nil
    }
}

/// The versions row: `Menu 0.12.0 · Runner v0.12.0`.
public func versionsLine(menu: String, runner: RunnerStatus.Update?) -> String {
    "Menu \(menu) · Runner \(runner?.installed ?? "unknown")"
}

/// Runs `/bin/sh -c script` in a session of its own and waits for it. Its own session keeps it alive when launchd
/// stops this app's job (`launchctl kickstart -k` or `bootout` from install.sh kill the job's whole process group).
/// Output goes to `log`. Nil when it exited 0; else why not.
public func runDetached(_ script: String, log: URL) async -> String? {
    await Task.detached {
        spawnAndWait(["/bin/sh", "-c", script], log: log.path)
    }.value
}

func spawnAndWait(_ arguments: [String], log: String) -> String? {
    var attributes = posix_spawnattr_t(nil as OpaquePointer?)
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID))
    var files = posix_spawn_file_actions_t(nil as OpaquePointer?)
    posix_spawn_file_actions_init(&files)
    defer { posix_spawn_file_actions_destroy(&files) }
    posix_spawn_file_actions_addopen(&files, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_addopen(&files, 1, log, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    posix_spawn_file_actions_adddup2(&files, 1, 2)
    let environment = ProcessInfo.processInfo.environment.map { "\($0.key)=\($0.value)" }
    var argv = arguments.map { strdup($0) } + [nil]
    var envp = environment.map { strdup($0) } + [nil]
    defer {
        argv.forEach { free($0) }
        envp.forEach { free($0) }
    }
    var pid: pid_t = 0
    let spawned = posix_spawn(&pid, arguments[0], &files, &attributes, &argv, &envp)
    guard spawned == 0 else { return "could not start: \(String(cString: strerror(spawned)))" }
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1, errno == EINTR {}
    let signal = status & 0x7F
    if signal != 0 { return "stopped by signal \(signal)" }
    let code = (status >> 8) & 0xFF
    return code == 0 ? nil : "exit \(code)"
}
