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

    var body: some View {
        VStack(spacing: 0) {
            DemoBar(demo: demo, openWorkerSetting: { showsWorkerSetting = true })
            Divider()
            FeedbackRequestsView(model: demo.model)
                .id(demo.modelKey)
        }
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
            return "Live: \(url.host() ?? url.absoluteString). The Worker decides what your login gets."
        }
        return demo.role.summary
    }

    private var badge: some View {
        Text(demo.liveURL == nil ? "Demo" : "Live")
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
                } header: {
                    Text("Worker")
                } footer: {
                    Text("The app backend that serves /feedback (docs/api.md). The token stays in this device's "
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
