import Foundation

/// The builders block: each builder in the order a new chat tries them, on or off as saved, and whether the runner
/// still has to apply that. The saved config is the one being written (shown at once, before SSH answers), else
/// builders.json as last read; without either it is what status.json says the runner works by.
public struct BuildersDisplay: Sendable, Equatable {
    /// In the saved order, each `on` as saved; `up` and `detail` are the runner's last full tick's.
    public var builders: [RunnerStatus.Builder]
    /// The builder new chats start on: the first that takes new chats.
    public var firstChoice: String?
    /// The saved config differs from what status.json says the runner works by: it applies it from its next full tick.
    public var applying: Bool

    public init(status: RunnerStatus, saved: BuildersConfig?) {
        let byHost = Dictionary(status.builders.map { ($0.host, $0) }, uniquingKeysWith: { first, _ in first })
        var builders = status.builders
        if let saved {
            // As the runner reads the file: hosts it does not know are left out, and those its order leaves out
            // follow the listed ones (here in status.json's order).
            var listed: [String] = []
            for host in saved.order where byHost[host] != nil && !listed.contains(host) {
                listed.append(host)
            }
            let hosts = listed + status.builders.map(\.host).filter { !listed.contains($0) }
            let off = Set(saved.off)
            builders = hosts.compactMap { host in
                byHost[host].map { builder in
                    var builder = builder
                    builder.on = !off.contains(host)
                    return builder
                }
            }
        }
        self.builders = builders
        firstChoice = builders.first(where: \.on)?.host
        applying = builders.map(\.host) != status.builders.map(\.host)
            || builders.map(\.on) != builders.map { byHost[$0.host]?.on ?? true }
    }

    /// The whole config as shown, which a change starts from.
    public var config: BuildersConfig {
        BuildersConfig(order: builders.map(\.host), off: builders.filter { !$0.on }.map(\.host))
    }
}

public extension RunnerStatus.Builder.State {
    /// The builder's state in a word or two.
    var word: String {
        switch self {
        case .up: "Up"
        case .down: "Not answering"
        case .off: "Off"
        }
    }
}
