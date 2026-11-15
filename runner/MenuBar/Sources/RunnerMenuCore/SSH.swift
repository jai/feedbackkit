import Foundation

/// A command on the Mac mini over SSH, with Jai's own SSH config and keys: no tokens of the app's own. One connection is
/// shared between checks for two minutes, so a check every 10 s costs one round trip, not a new session.
public struct SSH: Sendable {
    public struct Result: Sendable, Equatable {
        public var status: Int32
        public var output: String
        public var error: String

        /// ssh's own exit when it could not reach the host.
        public var unreachable: Bool { status == 255 }
    }

    public var host: String

    public init(host: String) {
        self.host = host
    }

    public var arguments: [String] {
        [
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=5",
            "-o", "ControlMaster=auto",
            "-o", "ControlPersist=120",
            "-o", "ControlPath=~/.ssh/feedbackkit-runner-menu-%C",
            "-o", "ServerAliveInterval=5",
            "-o", "ServerAliveCountMax=2",
            host,
        ]
    }

    /// Runs `script` on the host; a run past `timeout` is stopped and answers as unreachable. Output goes through
    /// files, so a long answer never fills a pipe.
    public func run(_ script: String, timeout: TimeInterval = 20) async -> Result {
        let arguments = arguments + [script]
        return await Task.detached {
            SSH.runBlocking(arguments, timeout: timeout)
        }.value
    }

    static func runBlocking(_ arguments: [String], timeout: TimeInterval) -> Result {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("feedbackkit-runner-menu-\(UUID().uuidString)")
        let outURL = folder.appendingPathComponent("out")
        let errURL = folder.appendingPathComponent("err")
        defer { try? FileManager.default.removeItem(at: folder) }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: outURL.path, contents: nil)
            FileManager.default.createFile(atPath: errURL.path, contents: nil)
            let out = try FileHandle(forWritingTo: outURL)
            let err = try FileHandle(forWritingTo: errURL)
            defer {
                try? out.close()
                try? err.close()
            }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
            process.arguments = arguments
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = out
            process.standardError = err
            try process.run()
            let deadline = Date().addingTimeInterval(timeout)
            while process.isRunning, Date() < deadline {
                Thread.sleep(forTimeInterval: 0.05)
            }
            if process.isRunning {
                process.terminate()
                process.waitUntilExit()
                return Result(status: 255, output: "", error: "no answer in \(Int(timeout)) s")
            }
            let output = (try? String(contentsOf: outURL, encoding: .utf8)) ?? ""
            let error = (try? String(contentsOf: errURL, encoding: .utf8)) ?? ""
            return Result(status: process.terminationStatus, output: output, error: error)
        } catch {
            return Result(status: 255, output: "", error: "ssh did not start: \(error.localizedDescription)")
        }
    }
}

/// The runner on the Mac mini, through SSH: look at it, restart it, fetch its whole log.
public struct RunnerHost: Sendable {
    public static let label = "com.jai.feedbackkit-runner"
    public var ssh: SSH

    public init(ssh: SSH) {
        self.ssh = ssh
    }

    /// The snapshot, or why the Mac mini did not answer.
    public func look() async -> (Snapshot?, String?) {
        let result = await ssh.run(Snapshot.script())
        if result.unreachable {
            return (nil, lastLine(result.error) ?? "no answer")
        }
        return (Snapshot.parse(result.output), nil)
    }

    /// launchctl kickstart -k: the runner stops after the delivery in progress (SIGTERM) and launchd starts it again.
    /// Nil when it went; else why not.
    public func restart() async -> String? {
        let result = await ssh.run("launchctl kickstart -k \"gui/$(id -u)/\(Self.label)\"", timeout: 360)
        return result.status == 0 ? nil : lastLine(result.error) ?? "exit \(result.status)"
    }

    /// The log's last `lines` lines.
    public func log(lines: Int = 2000) async -> Result<String, RunnerHostError> {
        let result = await ssh.run("tail -n \(lines) \"$HOME/Library/Logs/feedbackkit-runner.log\"", timeout: 60)
        return result.status == 0 ? .success(result.output)
            : .failure(RunnerHostError(reason: lastLine(result.error) ?? "exit \(result.status)"))
    }
}

public struct RunnerHostError: Error, Sendable {
    public var reason: String
}

func lastLine(_ text: String) -> String? {
    text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.last { !$0.isEmpty }
}
