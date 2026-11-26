import AgentChatLive
import Foundation
import Observation

/// What of an open chat can change its row in the list: how many messages it has, and whether its agent works.
struct ChatMark: Equatable {
    let messages: Int
    let isWorking: Bool
}

/// The reads of the list an open chat's changes ask for, one at a time.
struct ListReads {
    /// What each open chat last showed of itself.
    var marks: [String: ChatMark] = [:]
    /// The read under way, for a test to wait on.
    var task: Task<Void, Never>?
    /// A chat changed during that read: one more follows it.
    var again = false
}

extension Error {
    /// The task that asked was cancelled (a `.task` whose view went, an app leaving the foreground): `URLSession` says
    /// so with `URLError.cancelled`, structured concurrency with `CancellationError`. Nothing failed, so nothing is
    /// shown.
    var isCancellation: Bool {
        self is CancellationError || (self as? URLError)?.code == .cancelled
    }
}

/// The list: its reads, what the device keeps of it, and the changes made on the device ahead of the Worker's next
/// answer. `needsAttentionCount` (FeedbackAttention.swift) is counted from it.
extension FeedbackRequestsModel {
    /// Reads the list again: its rows, and with them `needsAttentionCount`. The Feedback screen does at each opening
    /// and pull, and an open chat when it changes; a host does where it knows more (`feedbackAttention` reads at
    /// launch and at each foreground, `received` at a push).
    public func refresh() async {
        if let samples = client.samples {
            if list.threads.isEmpty {
                list = samples.list
            }
            hasReadList = true
            return
        }
        do {
            let read = try await client.list()
            let isNew = read != list || !hasReadList
            list = read
            hasReadList = true
            listError = nil
            if isNew {
                keepList()
            }
        } catch where error.isCancellation {
            // The screen that asked went away, or the app left the foreground: no read failed, and the next one says.
        } catch {
            listError = client.direct == nil ? error.localizedDescription : Self.listProblem
        }
    }

    /// What the list says under its rows when a read of it failed on the direct path, whose errors can carry signed
    /// URLs. The rows above it are the last ones read; the list is read again at each opening, pull and foreground.
    static let listProblem = "Could not refresh this list. It is read again each time you open it."

    /// The list as it stands, written for the next launch. Off the main actor: the encode and the write.
    private func keepList() {
        guard let keep else {
            return
        }
        let list = list
        keeping = Task.detached(priority: .utility) { keep.keep(list) }
    }

    /// One listed chat, changed on the device ahead of the Worker's next list; nil from `change` leaves it as it is.
    /// True when it changed.
    @discardableResult
    func change(_ thread: String, _ change: (FeedbackThread) -> FeedbackThread?) -> Bool {
        guard let index = list.threads.firstIndex(where: { $0.id == thread }),
              let changed = change(list.threads[index])
        else {
            return false
        }
        list.threads[index] = changed
        keepList()
        return true
    }

    /// The sender's message reached the chat: a question of its agent's is no longer open, before the Worker's next
    /// list says so. That list is read too, in case one read before the message was still on its way.
    func answered(_ thread: String) {
        if change(thread, { $0.needsAttention ? $0.answered() : nil }) {
            readListSoon()
        }
    }

    /// Reads the list behind an open chat that changed, one read at a time: a change during a read reads once more.
    private func readListSoon() {
        guard listReads.task == nil else {
            listReads.again = true
            return
        }
        listReads.task = Task { [weak self] in
            await self?.refresh()
            guard let self else {
                return
            }
            listReads.task = nil
            if listReads.again {
                listReads.again = false
                readListSoon()
            }
        }
    }

    /// An open chat as last read. The list is read again when it gains a message or its agent starts or stops, since
    /// that is when its row, and whether it needs the sender, can change; never on its first sight.
    func chatShows(_ thread: String, messages: Int, isWorking: Bool) {
        let mark = ChatMark(messages: messages, isWorking: isWorking)
        if let last = listReads.marks[thread], last != mark {
            readListSoon()
        }
        listReads.marks[thread] = mark
    }

    /// While this follower follows the chat, each change the live room sends is weighed (`chatShows`). The room's
    /// state carries no word of a question, so the list is what says the chat needs the sender.
    func watch(_ live: LiveChatModel, thread: String, follower: UUID) {
        withObservationTracking {
            if live.chat.cursor != nil || live.chat.state != nil {
                chatShows(thread, messages: live.chat.messages.count, isWorking: live.chat.state?.working ?? false)
            }
        } onChange: { [weak self, weak live] in
            Task { @MainActor in
                guard let self, let live, self.followers[thread]?.id == follower else {
                    return
                }
                self.watch(live, thread: thread, follower: follower)
            }
        }
    }
}
