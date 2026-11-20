import RunnerMenuCore
import SwiftUI

/// FeedbackKit Runner: the runner on the Mac mini, from the menu bar of Jai's Mac (runner/MenuBar/README.md).
@main
struct FeedbackKitRunnerMenuApp: App {
    @State private var model = RunnerModel()

    var body: some Scene {
        MenuBarExtra {
            RunnerPanel(model: model)
                .frame(width: 460)
        } label: {
            Image(systemName: model.health.symbol)
                .accessibilityLabel(model.health.summary)
        }
        .menuBarExtraStyle(.window)
    }
}

struct RunnerPanel: View {
    let model: RunnerModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let now = context.date.timeIntervalSince1970
            VStack(alignment: .leading, spacing: 12) {
                header(now: now)
                if let update = model.update {
                    updateLine(update)
                }
                Divider()
                if let status = model.snapshot?.status {
                    RunnerSection(model: model, status: status, now: now)
                    Divider()
                    ChatsSection(status: status, now: now, open: model.open)
                    Divider()
                }
                LogSection(lines: model.snapshot?.log ?? [])
                Divider()
                actions
            }
            .padding(14)
        }
        .task { await model.refresh() }
    }

    private func header(now: Double) -> some View {
        let health = model.health
        return HStack(alignment: .firstTextBaseline) {
            Image(systemName: health.symbol)
                .foregroundStyle(color(health))
            Text(health.summary)
                .font(.headline)
                .lineLimit(2)
                .textSelection(.enabled)
                .help(health.summary)
            Spacer()
            if case let .failed(key, _) = health {
                Button("Dismiss") { model.dismiss(key) }
                    .controlSize(.small)
                    .help("Stop counting this failed message as a problem; its chat stays in the list")
            }
            Text("Checked \(ago(model.checkedAt, now: now))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func updateLine(_ update: Version) -> some View {
        HStack {
            Text("Update available: \(update.description)").font(.caption)
            Spacer()
            Button("Install update") { Task { await model.installUpdate() } }
                .controlSize(.small)
                .disabled(model.busy != nil)
        }
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let busy = model.busy {
                Text(busy).font(.caption).foregroundStyle(.secondary)
            }
            if let error = model.actionError {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            HStack {
                Button("Restart runner") { Task { await model.restart() } }
                    .disabled(model.busy != nil)
                Button("Open full log") { Task { await model.openLog() } }
                    .disabled(model.busy != nil)
                Button("Refresh") { Task { await model.refreshByHand() } }
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
            }
        }
    }

    private func color(_ health: Health) -> Color {
        switch health {
        case .ok: .green
        case .working: .blue
        case .problem, .failed: .orange
        }
    }
}

struct RunnerSection: View {
    let model: RunnerModel
    let status: RunnerStatus
    let now: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Runner on the Mac mini").font(.subheadline.bold())
            row("Process", status.pid.map { "pid \($0), started \(ago(status.startedAt, now: now))" } ?? "unknown")
            row("Last full tick", status.lastFullTick.map { "\(ago($0.at, now: now)), \(format($0.seconds)) s" } ?? "none yet")
            row("Last wake", ago(status.longPoll?.lastWake, now: now) + (status.longPoll?.on == false ? " (no long poll)" : ""))
            row("FeedbackKit Worker", status.poll.map { poll in
                poll.ok ? "answered \(ago(poll.at, now: now))" : "unreachable: \(poll.error ?? "no answer")"
            } ?? "not polled yet")
            versions
            HStack(spacing: 10) {
                Text("Builders").foregroundStyle(.secondary).frame(width: 130, alignment: .leading)
                ForEach(status.builders) { builder in
                    BuilderMenu(builder: builder, first: builder.id == status.builders.first?.id, config: BuildersConfig(status)) { config in
                        Task { await model.setBuilders(config) }
                    }
                    .disabled(model.busy != nil)
                }
            }
            .font(.caption)
            if let error = status.buildersConfigError {
                Text("builders.json ignored: \(error)")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .padding(.leading, 138)
            }
        }
    }

    private var versions: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Versions").foregroundStyle(.secondary).frame(width: 130, alignment: .leading)
            Text(versionsLine(menu: model.version, runner: status.update))
            if let error = status.update?.error {
                Text(error).foregroundStyle(.orange).lineLimit(2)
            }
        }
        .font(.caption)
        .help(model.updateError.map { "Update check failed: \($0)" } ?? model.commit.map { "Menu built from \($0)" } ?? "")
    }

    private func row(_ name: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(name).foregroundStyle(.secondary).frame(width: 130, alignment: .leading)
            Text(value).lineLimit(2)
        }
        .font(.caption)
    }

    private func format(_ seconds: Double) -> String {
        String(format: "%.1f", seconds)
    }
}

/// A builder's label, as a menu: take new chats or not, try it first, and why its Orca does not answer.
struct BuilderMenu: View {
    let builder: RunnerStatus.Builder
    let first: Bool
    let config: BuildersConfig
    let save: (BuildersConfig) -> Void

    var body: some View {
        Menu {
            if builder.on {
                Button("Stop new chats") { save(config.turning(builder.host, on: false)) }
            } else {
                Button("Take new chats") { save(config.turning(builder.host, on: true)) }
            }
            if !first {
                Button("Try first") { save(config.tryingFirst(builder.host)) }
            }
            if !builder.up, let detail = builder.detail {
                Divider()
                Text(detail)
            }
        } label: {
            Label(builder.name, systemImage: symbol)
                .foregroundStyle(color)
        }
        .menuStyle(.button)
        .buttonStyle(.borderless)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(help)
    }

    private var symbol: String {
        switch builder.state {
        case .off: "pause.circle.fill"
        case .up: "checkmark.circle.fill"
        case .down: "xmark.circle.fill"
        }
    }

    private var color: Color {
        switch builder.state {
        case .off: .secondary
        case .up: .green
        case .down: .orange
        }
    }

    private var help: String {
        switch builder.state {
        case .off: "Takes no new chats; its chats stay on it"
        case .up: "Orca answers"
        case let .down(detail): detail ?? "Orca does not answer"
        }
    }
}

struct ChatsSection: View {
    /// The list grows with its rows up to this, then scrolls.
    static let maxHeight: CGFloat = 260

    let status: RunnerStatus
    let now: Double
    let open: (RunnerStatus.Thread) -> Void
    /// The rows' own height, measured. A `.window` menu bar extra sizes its window to the content's ideal size, and a
    /// ScrollView's ideal height is not its content's, so without a set height the list collapses to nothing.
    @State private var rowsHeight: CGFloat = 0

    var body: some View {
        let groups = status.chatsByApp(now: now)
        VStack(alignment: .leading, spacing: 6) {
            Text("Feedback chats").font(.subheadline.bold())
            if groups.isEmpty {
                Text("None").font(.caption).foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(groups) { group in
                            Text(group.app).font(.caption.bold()).foregroundStyle(.secondary)
                            ForEach(group.chats) { chat in
                                ChatRow(chat: chat, now: now, open: open)
                            }
                        }
                    }
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { rowsHeight = $0 }
                }
                .frame(height: min(rowsHeight, Self.maxHeight))
            }
        }
    }
}

struct ChatRow: View {
    let chat: RunnerStatus.Chat
    let now: Double
    let open: (RunnerStatus.Thread) -> Void

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(chat.name).lineLimit(1)
                Text(details).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer()
            if let state = chat.state {
                Text(state)
                    .font(.caption2.bold())
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(stateColor(state).opacity(0.18), in: Capsule())
                    .foregroundStyle(stateColor(state))
            }
            Button {
                if let thread = chat.thread { open(thread) }
            } label: {
                Image(systemName: "arrow.up.forward.app")
            }
            .buttonStyle(.borderless)
            .disabled(chat.thread == nil)
            .help(chat.thread.map { "Open \($0.id) on \($0.host) in Agent Pager" } ?? "No coding thread found yet")
        }
        .font(.caption)
    }

    private var details: String {
        var parts = [chat.login.map { "@\($0)" } ?? "unknown sender"]
        if let thread = chat.thread {
            parts.append("\(thread.host) · \(thread.id)")
        } else if let host = chat.host {
            parts.append(host)
        }
        if chat.working {
            parts.append(chat.activity ?? "working")
        } else if chat.removed {
            parts.append("tidied away")
        }
        if let failed = chat.messages.last(where: { $0.state == "failed" }), let detail = failed.detail {
            parts.append("failed: \(detail)")
        }
        parts.append(ago(chat.messages.last?.at ?? chat.lastActivity, now: now))
        return parts.joined(separator: " · ")
    }

    private func stateColor(_ state: String) -> Color {
        switch state {
        case "delivered": .green
        case "failed": .red
        case "pending", "delivering", "queued": .blue
        default: .secondary
        }
    }
}

struct LogSection: View {
    let lines: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Log").font(.subheadline.bold())
            ScrollViewReader { reader in
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(lines.suffix(50).enumerated()), id: \.offset) { index, line in
                            Text(line)
                                .font(.system(size: 10, design: .monospaced))
                                .textSelection(.enabled)
                                .lineLimit(2)
                                .id(index)
                        }
                    }
                }
                .frame(height: 150)
                .onChange(of: lines) {
                    reader.scrollTo(min(lines.count, 50) - 1, anchor: .bottom)
                }
            }
        }
    }
}
