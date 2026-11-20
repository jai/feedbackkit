import Foundation

/// builders.json on the Mac mini (runner/README.md): the order a new chat tries the builders in, and the builders that
/// take no new chat. The menu writes the whole file; the runner reads it each full tick.
public struct BuildersConfig: Codable, Sendable, Equatable {
    public var order: [String]
    public var off: [String]

    public init(order: [String], off: [String]) {
        self.order = order
        self.off = off
    }

    /// The config the runner works by now: status.json lists the builders in its order, each with `on`.
    public init(_ status: RunnerStatus) {
        order = status.builders.map(\.host)
        off = status.builders.filter { !$0.on }.map(\.host)
    }

    /// With `host` taking new chats (`on`) or not.
    public func turning(_ host: String, on: Bool) -> BuildersConfig {
        var config = self
        config.off.removeAll { $0 == host }
        if !on {
            config.off.append(host)
        }
        return config
    }

    /// With `host` the first a new chat tries.
    public func tryingFirst(_ host: String) -> BuildersConfig {
        var config = self
        config.order.removeAll { $0 == host }
        config.order.insert(host, at: 0)
        return config
    }

    /// One line of JSON, keys sorted.
    public func json() -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = (try? encoder.encode(self)) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    static let end = "FEEDBACKKIT_BUILDERS_JSON"

    /// The remote command that replaces builders.json with this config at once: written to a mode 600 file beside it,
    /// then moved over it, so the runner never reads half a file.
    public func writeScript() -> String {
        let folder = "\"$HOME/Library/Application Support/feedbackkit-runner\""
        return """
        mkdir -p \(folder) && cd \(folder) && rm -f builders.json.tmp && umask 077 \
        && cat > builders.json.tmp <<'\(Self.end)' && chmod 600 builders.json.tmp && mv builders.json.tmp builders.json
        \(json())
        \(Self.end)
        """
    }
}
