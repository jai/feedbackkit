import Testing
@testable import FeedbackKit

/// The app's own foreground state, which keeps a hosted Feedback screen live when `scenePhase` never leaves
/// `.background` (#9).
@MainActor
struct AppActivityTests {
    @Test func aRunningAppThatIsNotHiddenIsInTheForeground() {
        #expect(AppActivity().isActive)
    }
}
