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
        .package(url: "https://github.com/jai/agentchatkit", from: "0.12.0"),
        .package(url: "https://github.com/jai/durable-networking", from: "0.1.0"),
    ],
    targets: [
        .target(name: "FeedbackKit", dependencies: [
            .product(name: "AgentChatKit", package: "agentchatkit"),
            .product(name: "AgentChatLive", package: "agentchatkit"),
            .product(name: "DurableNetworking", package: "durable-networking"),
        ]),
        .target(name: "FeedbackKitTestSupport", dependencies: [
            "FeedbackKit", .product(name: "DurableNetworking", package: "durable-networking"),
        ], path: "Tests/FeedbackKitTestSupport"),
        .testTarget(name: "FeedbackKitTests", dependencies: [
            "FeedbackKit", "FeedbackKitTestSupport",
            .product(name: "AgentChatLive", package: "agentchatkit"),
            .product(name: "DurableNetworking", package: "durable-networking"),
        ], path: "Tests/FeedbackKitTests/Unit"),
        .testTarget(name: "FeedbackKitIntegrationTests", dependencies: [
            "FeedbackKit", "FeedbackKitTestSupport",
            .product(name: "AgentChatLive", package: "agentchatkit"),
            .product(name: "AgentChatLiveTesting", package: "agentchatkit"),
            .product(name: "DurableNetworking", package: "durable-networking"),
        ], path: "Tests/FeedbackKitTests/Integration"),
        .testTarget(name: "FeedbackKitRenderingTests", dependencies: ["FeedbackKit"]),
    ]
)
