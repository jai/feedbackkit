import Foundation

/// One look at the runner over SSH: whether its LaunchAgent is loaded, its status.json, builders.json, and its log's
/// last lines.
public struct Snapshot: Sendable, Equatable {
    public var loaded: Bool
    public var status: RunnerStatus?
    /// Why status.json could not be read, when it could not.
    public var statusError: String?
    /// builders.json as saved, which the runner may not have applied yet; nil when there is none or the runner would
    /// ignore it (status.json then says why).
    public var builders: BuildersConfig?
    public var log: [String]

    public init(loaded: Bool, status: RunnerStatus?, statusError: String?, builders: BuildersConfig? = nil, log: [String]) {
        self.loaded = loaded
        self.status = status
        self.statusError = statusError
        self.builders = builders
        self.log = log
    }

    static let statusMark = "---feedbackkit-runner-status---"
    static let buildersMark = "---feedbackkit-runner-builders---"
    static let logMark = "---feedbackkit-runner-log---"
    static let loadedMark = "---feedbackkit-runner-loaded---"

    /// The one remote command that prints all four, each after its mark.
    public static func script(logLines: Int = 60) -> String {
        let label = "com.jai.feedbackkit-runner"
        let folder = "\"$HOME/Library/Application Support/feedbackkit-runner\""
        return """
        echo '\(loadedMark)'; launchctl print "gui/$(id -u)/\(label)" >/dev/null 2>&1 && echo yes || echo no; \
        echo '\(statusMark)'; cat \(folder)/status.json 2>/dev/null; echo; \
        echo '\(buildersMark)'; cat \(folder)/builders.json 2>/dev/null; echo; \
        echo '\(logMark)'; tail -n \(logLines) "$HOME/Library/Logs/feedbackkit-runner.log" 2>/dev/null
        """
    }

    /// The script's output, read back. Lines outside the marks are ignored.
    public static func parse(_ output: String) -> Snapshot {
        var section = ""
        var parts: [String: [String]] = [:]
        for line in output.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if [loadedMark, statusMark, buildersMark, logMark].contains(line) {
                section = line
                continue
            }
            parts[section, default: []].append(line)
        }
        let loaded = parts[loadedMark]?.contains("yes") ?? false
        let json = (parts[statusMark] ?? []).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        var status: RunnerStatus?
        var statusError: String?
        if json.isEmpty {
            statusError = "no status.json yet"
        } else {
            do {
                status = try RunnerStatus.decode(Data(json.utf8))
            } catch {
                statusError = "status.json unreadable: \(error)"
            }
        }
        let builders = BuildersConfig.decode((parts[buildersMark] ?? []).joined(separator: "\n"))
        let log = (parts[logMark] ?? []).filter { !$0.isEmpty }
        return Snapshot(loaded: loaded, status: status, statusError: statusError, builders: builders, log: log)
    }
}
