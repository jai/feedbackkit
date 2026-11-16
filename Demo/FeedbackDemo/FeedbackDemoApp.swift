import FeedbackKit
import SwiftUI

/// FeedbackKit's demo: `FeedbackRequestsView` over a mock Worker in the app, with a switch for who is sending.
@main
struct FeedbackDemoApp: App {
    @State private var demo = DemoState()

    var body: some Scene {
        WindowGroup {
            DemoRootView(demo: demo)
        }
        #if os(macOS)
        .defaultSize(width: 980, height: 680)
        #endif
    }
}

/// The role switch over the Feedback screen. Holding the Demo badge opens the hidden Worker setting.
struct DemoRootView: View {
    @Bindable var demo: DemoState
    @State private var showsWorkerSetting = false
    @State private var lastThreadAction = ""
    private var isFixture: Bool { ProcessInfo.processInfo.environment["FEEDBACKKIT_LIVE_FIXTURE"] != nil }
    private var showsThreadControls: Bool { ProcessInfo.processInfo.arguments.contains("-DemoThreadControls") }

    private var captureScheme: ColorScheme? {
        switch ProcessInfo.processInfo.environment["FEEDBACKKIT_DEMO_APPEARANCE"] {
        case "dark": .dark
        case "light", "large": .light
        default: nil
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            DemoBar(demo: demo, openWorkerSetting: { showsWorkerSetting = true })
            Divider()
            if !lastThreadAction.isEmpty {
                Text(lastThreadAction).accessibilityIdentifier("demo-thread-action")
            }
            if let error = demo.directError {
                Text(error).accessibilityIdentifier("demo-direct-error")
            }
            if demo.needsDirectConnection {
                if demo.directError == nil {
                    ProgressView("Connecting direct feedback…")
                }
                Spacer()
            } else {
                FeedbackRequestsView(model: demo.model)
                    .threadRows(label: { thread in
                        guard showsThreadControls || isFixture else { return nil }
                        return AnyView(ChatThreadRow(title: thread.title, context: "Demo agent", about: "Shared conversation row") {
                            Text("Working")
                        } chips: {
                            Text("Demo chip")
                        })
                    }, actions: { thread in
                        guard showsThreadControls || isFixture else { return ChatThreadActions() }
                        return ChatThreadActions(archive: {
                            lastThreadAction = "Archive hook: \(thread.title)"
                            return .success(())
                        }, delete: {
                            lastThreadAction = "Delete hook: \(thread.title)"
                            return .success(())
                        })
                    })
                    .id(demo.modelKey)
            }
        }
        .preferredColorScheme(captureScheme)
        .transformEnvironment(\.dynamicTypeSize) { size in
            if ProcessInfo.processInfo.environment["FEEDBACKKIT_DEMO_APPEARANCE"] == "large" { size = .accessibility3 }
        }
        .task(id: demo.live) { await demo.resolveDirect() }
        .sheet(isPresented: $showsWorkerSetting) {
            LiveWorkerSheet(settings: demo.live) { demo.apply($0) }
        }
    }
}

/// The demo's own strip: the badge, the role switch, and what sending does for that role.
private struct DemoBar: View {
    @Bindable var demo: DemoState
    let openWorkerSetting: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                badge
                if demo.liveURL == nil {
                    Picker("Sending as", selection: $demo.role) {
                        ForEach(DemoRole.allCases) { role in
                            Text(role.label).tag(role)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .accessibilityIdentifier("demo-role")
                } else {
                    Spacer()
                }
            }
            Text(caption)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("demo-role-summary")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
    }

    private var caption: String {
        if let url = demo.liveURL {
            let how = demo.live.isDirect ? "Direct to FeedbackKit, token from" : "Live:"
            return "\(how) \(url.host() ?? url.absoluteString). The Worker decides what your login gets."
        }
        return demo.role.summary
    }

    private var badge: some View {
        Text(demo.liveURL == nil ? "Demo" : (demo.live.isDirect ? "Direct" : "Live"))
            .font(.caption.weight(.bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(demo.liveURL == nil ? Color.accentColor : Color.orange, in: .capsule)
            .onLongPressGesture(minimumDuration: 1.2, perform: openWorkerSetting)
            .accessibilityIdentifier("demo-badge")
    }
}

/// The hidden setting: a real Worker's URL and bearer, off by default.
private struct LiveWorkerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State var settings: LiveWorker
    let save: (LiveWorker) -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Use a real Worker", isOn: $settings.isEnabled)
                        .accessibilityIdentifier("live-worker-enabled")
                } footer: {
                    Text("Off, the demo runs on its own mock Worker and nothing leaves the device.")
                }
                Section {
                    TextField("https://your-app.workers.dev", text: $settings.url)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                    SecureField("Bearer token", text: $settings.token)
                    Toggle("Direct to FeedbackKit", isOn: $settings.isDirect)
                        .accessibilityIdentifier("live-worker-direct")
                } header: {
                    Text("Worker")
                } footer: {
                    Text(settings.isDirect
                        ? "The app backend issues FeedbackKit tokens (POST /feedback/token, sample-worker/); the demo "
                        + "then talks to FeedbackKit itself. The token stays in this device's Keychain."
                        : "The app backend that serves /feedback (docs/api.md). The token stays in this device's "
                        + "Keychain.")
                }
                .disabled(!settings.isEnabled)
            }
            .formStyle(.grouped)
            .navigationTitle("Worker")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        save(settings)
                        dismiss()
                    }
                    .disabled(settings.isEnabled && settings.baseURL == nil)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 320)
        #endif
    }
}
