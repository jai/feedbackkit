import Observation
import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Whether the app itself is in the foreground, from the system's notifications. A Feedback screen hosted outside a
/// SwiftUI app scene (a hosting controller in a UIKit or React Native app) reads `scenePhase` as `.background` for
/// good, so on its own that phase would keep a chat from ever going live (#9).
@MainActor
@Observable
final class AppActivity {
    private(set) var isActive: Bool
    @ObservationIgnored private nonisolated(unsafe) var observers: [NSObjectProtocol] = []

    init() {
        let center = NotificationCenter.default
        #if canImport(UIKit)
        isActive = UIApplication.shared.applicationState != .background
        observers = [
            center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) {
                [weak self] _ in MainActor.assumeIsolated { self?.isActive = true }
            },
            center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) {
                [weak self] _ in MainActor.assumeIsolated { self?.isActive = true }
            },
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) {
                [weak self] _ in MainActor.assumeIsolated { self?.isActive = false }
            },
        ]
        #elseif canImport(AppKit)
        // A Mac app's window stays live while it is not frontmost; only a hidden app is away.
        isActive = !NSApplication.shared.isHidden
        observers = [
            center.addObserver(forName: NSApplication.didUnhideNotification, object: nil, queue: .main) {
                [weak self] _ in MainActor.assumeIsolated { self?.isActive = true }
            },
            center.addObserver(forName: NSApplication.didHideNotification, object: nil, queue: .main) {
                [weak self] _ in MainActor.assumeIsolated { self?.isActive = false }
            },
        ]
        #else
        isActive = true
        #endif
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }
}
