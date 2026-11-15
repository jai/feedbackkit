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
                Divider()
                if let status = model.snapshot?.status {
                    RunnerSection(status: status, now: now)
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
            Spacer()
            Text("Checked \(ago(model.checkedAt, now: now))")
                .font(.caption)
                .foregroundStyle(.secondary)
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
                Button("Refresh") { Task { await model.refresh() } }
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
            }
        }
    }

    private func color(_ health: Health) -> Color {
        switch health {
        case .ok: .green
        case .working: .blue
        case .problem: .orange
        }
    }
}

struct RunnerSection: View {
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
            HStack(spacing: 10) {
                Text("Builders").foregroundStyle(.secondary).frame(width: 130, alignment: .leading)
                ForEach(status.builders) { builder in
                    Label(builder.name, systemImage: builder.up ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle(builder.up ? Color.green : Color.orange)
                        .help(builder.detail ?? "")
                }
            }
            .font(.caption)
        }
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

struct ChatsSection: View {
    let status: RunnerStatus
    let now: Double
    let open: (RunnerStatus.Thread) -> Void

    var body: some View {
        let groups = status.chatsByApp(now: now)
        VStack(alignment: .leading, spacing: 6) {
            Text("Feedback chats").font(.subheadline.bold())
            if groups.isEmpty {
                Text("None").font(.caption).foregroundStyle(.secondary)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(groups) { group in
                        Text(group.app).font(.caption.bold()).foregroundStyle(.secondary)
                        ForEach(group.chats) { chat in
                            ChatRow(chat: chat, now: now, open: open)
                        }
                    }
                }
            }
            .frame(maxHeight: 260)
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
