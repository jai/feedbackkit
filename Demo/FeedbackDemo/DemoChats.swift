import FeedbackKit
import Foundation

/// The chats each role starts with, as `FeedbackSamples`: the list and each request's conversation. `DemoWorker`
/// serves them and keeps what you send.
extension DemoRole {
    func samples(now: Date = .now) -> FeedbackSamples {
        let chats = chats
        let list = FeedbackList(
            threads: chats.map { FeedbackThread(id: $0.chat.id, title: $0.title, createdAt: $0.age.before(now)) },
            builderOnline: true,
            notice: self == .everyone
                ? "Sending opens a public GitHub issue on \(DemoRepo.name), where anyone can read it." : nil
        )
        let byID = Dictionary(uniqueKeysWithValues: chats.map { ($0.chat.id, $0.chat) })
        return FeedbackSamples(
            list: list,
            chat: { id in
                byID[id] ?? FeedbackChat(
                    id: id, messages: [], isWorking: false, activity: nil, problem: nil, costCents: nil,
                    builderOnline: true
                )
            },
            answer: script.answer
        )
    }

    private var chats: [SeedChat] {
        switch self {
        case .owner: [.working, .shipped, .failed]
        case .builder: [.reviewing, .pullRequest]
        case .everyone: [.issue]
        }
    }
}

/// A chat the demo starts with, and how long ago it was asked.
private struct SeedChat {
    let title: String
    let age: Age
    let chat: FeedbackChat

    enum Age {
        case minutes(Double)
        case hours(Double)
        case days(Double)

        func before(_ now: Date) -> String {
            let seconds = switch self {
            case .minutes(let count): count * 60
            case .hours(let count): count * 3_600
            case .days(let count): count * 86_400
            }
            return now.addingTimeInterval(-seconds).ISO8601Format()
        }
    }

    init(_ id: String, age: Age, messages: [(String, String)], isWorking: Bool = false, activity: String? = nil,
         problem: String? = nil, costCents: Int? = nil, delivery: FeedbackMessageDelivery = .delivered,
         screenshots: [String: Int] = [:]) {
        let messages = messages.enumerated().map { index, message in
            FeedbackChat.Message(id: "m\(index + 1)", role: message.0, text: message.1)
        }
        title = messages.first?.text ?? id
        self.age = age
        chat = FeedbackChat(
            id: id, messages: messages, isWorking: isWorking, activity: activity, problem: problem,
            costCents: costCents, builderOnline: true, screenshots: screenshots,
            delivery: Dictionary(uniqueKeysWithValues: messages.filter(\.isJai).map { ($0.id, delivery) })
        )
    }

    /// Owner: the agent is on it now.
    static let working = SeedChat(
        "demo-sync-button", age: .minutes(2),
        messages: [
            ("you", "Make the sync button bigger, it's hard to hit"),
            ("agent", "Found it in `SyncBar.swift`: it's 28 pt. Making it 44 pt, the smallest a finger hits reliably."),
        ],
        isWorking: true, activity: "Running the UI tests", costCents: 112, screenshots: ["m1": 1]
    )

    /// Owner: done and shipped.
    static let shipped = SeedChat(
        "demo-dark-settings", age: .hours(3),
        messages: [
            ("you", "Settings should follow dark mode"),
            ("agent", "Done. Settings follows the system appearance now, and build 41 is on TestFlight."),
            ("you", "Perfect, thanks"),
            ("agent", "Anytime."),
        ],
        costCents: 86
    )

    /// Owner: the builder Mac never took the message.
    static let failed = SeedChat(
        "demo-export-csv", age: .days(1),
        messages: [("you", "Export my notes as CSV")],
        problem: "This message didn't reach the builder Mac. Send it again to retry.", delivery: .failed
    )

    /// Builder: the agent is working toward a pull request.
    static let reviewing = SeedChat(
        "demo-haptics", age: .minutes(5),
        messages: [
            ("you", "Add a light haptic when a note saves"),
            ("agent", "On it. The save happens in `NoteStore.commit()`; I'll add the haptic there."),
        ],
        isWorking: true, activity: "Opening a pull request", costCents: 64
    )

    /// Builder: the pull request is open, waiting for an owner.
    static let pullRequest = SeedChat(
        "demo-paywall-typo", age: .hours(6),
        messages: [
            ("you", "Typo on the paywall: \"Unlimted\""),
            ("agent", "Fixed. I opened [pull request #57](\(DemoRepo.url)/pull/57). It ships once an owner merges it."),
        ],
        costCents: 18
    )

    /// Everyone else: a public issue, with a comment from the owner on GitHub.
    static let issue = SeedChat(
        "demo-rotate-crash", age: .days(2),
        messages: [
            ("you", "The app crashes when I rotate on the map"),
            ("agent", "I opened [issue #212](\(DemoRepo.url)/issues/212). The app's owners see it there, and their "
                + "comments show up here."),
            ("agent", "**@jai:** Thanks! I can reproduce it, and the fix is in the next build."),
        ]
    )
}
