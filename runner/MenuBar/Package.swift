// swift-tools-version: 6.2
import PackageDescription

// FeedbackKit Runner: a menu bar app on Jai's Mac that shows the runner on the Mac mini (README.md). Its own package,
// apart from FeedbackKit's: apps that use FeedbackKit never get it.
let package = Package(
    name: "FeedbackKitRunnerMenu",
    platforms: [.macOS(.v26)],
    products: [
        .executable(name: "FeedbackKitRunnerMenu", targets: ["FeedbackKitRunnerMenu"]),
    ],
    targets: [
        // What the app reads and decides, without SwiftUI: the runner's status, the log, the icon's state, SSH.
        .target(name: "RunnerMenuCore"),
        .executableTarget(name: "FeedbackKitRunnerMenu", dependencies: ["RunnerMenuCore"]),
        .testTarget(name: "RunnerMenuCoreTests", dependencies: ["RunnerMenuCore"]),
    ],
    swiftLanguageModes: [.v6]
)
