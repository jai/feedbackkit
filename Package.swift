// swift-tools-version: 6.2
import PackageDescription

// FeedbackKit: feedback from inside an app, each a conversation with the coding agent that changes it (README.md).
let package = Package(
    name: "FeedbackKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "FeedbackKit", targets: ["FeedbackKit"]),
    ],
    dependencies: [
        .package(url: "https://github.com/jai/agentchatkit", from: "0.1.0"),
    ],
    targets: [
        .target(name: "FeedbackKit", dependencies: [.product(name: "AgentChatKit", package: "agentchatkit")]),
        .testTarget(name: "FeedbackKitTests", dependencies: ["FeedbackKit"]),
    ]
)
