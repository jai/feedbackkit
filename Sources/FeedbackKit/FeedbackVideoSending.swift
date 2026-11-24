import AgentChatKit
import Foundation

// A message's videos on their way: made ready, put up, named on the message, and kept as what the sent message shows.

extension PendingMessage {
    /// The tray's contents as the message carries them: its pictures, then its videos (the Worker's order).
    init(text: String, attachments: [ComposerImage]) {
        self.init(
            text: text, screenshots: attachments.count,
            images: attachments.filter { $0.video == nil }.map(\.jpeg),
            videos: attachments.compactMap { image in image.video.map { PendingVideo(poster: image.jpeg, clip: $0) } }
        )
    }

    /// What the message's strip shows while it sends.
    var media: [SentMedia] {
        images.map(SentMedia.picture) + videos.map { .video(poster: $0.poster, clip: $0.clip) }
    }
}

extension FeedbackMessage {
    /// The same message sent again keeps its `client_ref`, so it lands once.
    func repeats(_ text: String, _ images: [MessageImage], _ videos: [MessageVideo]) -> Bool {
        self.text == text && self.images == images && self.videos ?? [] == videos
    }
}

extension FeedbackRequestsModel {
    /// A video goes as a video where it can: straight to FeedbackKit's Worker, which takes uploads, to the owner's or
    /// a builder's agent (or nowhere at all, with samples). Through a host's own backend, or to an issue, there is no
    /// way to send one, so there it is stills from across it, as before.
    var sendsVideos: Bool {
        client.samples != nil || (client.direct != nil && list.notice == nil)
    }

    /// Why a send did not go, in words for the composer: a video's own reason when it was the video.
    func sendProblem(_ error: any Error) -> String {
        if let problem = error as? FeedbackVideoProblem {
            return problem.words
        }
        return client.direct == nil ? error.localizedDescription : "Could not send feedback. Try again."
    }

    /// Each video made ready (`FeedbackVideoFile.prepared`) and put up, one at a time, before its message names it.
    /// One already up for this box is not sent again. Throws `FeedbackVideoProblem` and puts nothing more up.
    func upload(_ clips: [ChatVideoClip], for box: String) async throws -> [MessageVideo] {
        guard !clips.isEmpty else {
            return []
        }
        guard sendsVideos else {
            throw FeedbackVideoProblem.refused(status: 403)
        }
        var videos: [MessageVideo] = []
        for clip in clips {
            if let video = uploaded[box]?[clip.url] {
                videos.append(video)
                continue
            }
            let file = try await prepareVideo(clip.url)
            defer {
                if file.isCopy { try? FileManager.default.removeItem(at: file.url) }
            }
            let uri: String
            if let uploadVideo {
                uri = try await uploadVideo(file, clip.url.lastPathComponent)
            } else if let direct = client.direct {
                uri = try await direct.upload(file, name: clip.url.lastPathComponent)
            } else {
                // Samples: nothing leaves the device.
                uri = "sample:\(clip.url.lastPathComponent)"
            }
            let length = clip.duration.components
            let video = MessageVideo(
                uri: uri, mimeType: file.mimeType, size: file.size,
                duration_ms: Int(length.seconds * 1000 + length.attoseconds / 1_000_000_000_000_000)
            )
            uploaded[box, default: [:]][clip.url] = video
            videos.append(video)
        }
        return videos
    }

    /// The box's message went. Its videos' files become the ones its message shows (`FeedbackDirect.keepSent`), when
    /// the chat says which message it is; any other is removed.
    func videosSent(_ box: String, _ taken: [ComposerImage], in chat: FeedbackChat?, _ message: FeedbackMessage) {
        uploaded[box] = nil
        if let chat, client.direct != nil, let sent = chat.messages.last(where: \.isJai) {
            let videos = message.videos ?? []
            for (index, clip) in taken.compactMap(\.video).enumerated() where index < videos.count {
                FeedbackDirect.keepSent(
                    clip.url,
                    uri: FeedbackDirect.attachmentURI(chat: chat.id, message: sent.id,
                                                      index: message.images.count + index),
                    mimeType: videos[index].mimeType
                )
            }
        }
        ComposerAttachments.discard(taken)
    }
}
