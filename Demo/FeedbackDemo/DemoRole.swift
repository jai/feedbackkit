import Foundation

/// Who the demo sends as. The Worker decides this from the sender's login (docs/worker.md, "Who gets what"); the demo
/// lets you switch to see each.
enum DemoRole: String, CaseIterable, Identifiable, Sendable {
    case owner
    case builder
    case everyone

    var id: Self { self }

    var label: String {
        switch self {
        case .owner: "Owner"
        case .builder: "Builder"
        case .everyone: "Everyone else"
        }
    }

    /// What sending does for this role, under the switch.
    var summary: String {
        switch self {
        case .owner: "An agent makes the change, tests it and ships a build."
        case .builder: "An agent makes the change and opens a pull request for an owner to merge."
        case .everyone: "Each request becomes a public GitHub issue. Replies are comments on it."
        }
    }

    /// How the mock agent answers a message, step by step.
    var script: DemoScript {
        switch self {
        case .owner:
            DemoScript(
                isIssue: false,
                steps: ["Reading the app", "Making the change", "Running the tests", "Shipping a build"],
                answer: "Done. I made the change, the tests pass, and build {n} is on TestFlight now.",
                followUp: "Done. That's in build {n} too."
            )
        case .builder:
            DemoScript(
                isIssue: false,
                steps: ["Reading the app", "Making the change", "Running the tests", "Opening a pull request"],
                answer: "Done. I opened [pull request #{n}](\(DemoRepo.url)/pull/{n}). It ships once an owner "
                    + "merges it.",
                followUp: "Done. I pushed that to [pull request #{n}](\(DemoRepo.url)/pull/{n})."
            )
        case .everyone:
            DemoScript(
                isIssue: true,
                steps: ["Opening the issue on GitHub"],
                answer: "I opened [issue #{n}](\(DemoRepo.url)/issues/{n}). The app's owners see it there, and their "
                    + "comments show up here.",
                followUp: "I added that to the issue as a comment."
            )
        }
    }
}

/// The made-up repo the demo's chats link to.
enum DemoRepo {
    static let name = "example/notes-app"
    static let url = "https://github.com/\(name)"
}

/// One role's mock agent: the activities it shows while it works, then its answer. `{n}` is the build, pull request or
/// issue number.
struct DemoScript: Sendable {
    /// An issue Worker: no queue to the builder Mac, nothing to pay for.
    var isIssue: Bool
    var steps: [String]
    var answer: String
    var followUp: String
}
