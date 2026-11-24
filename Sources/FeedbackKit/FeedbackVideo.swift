import AgentChatKit
import AgentChatLive
import AVFoundation
import CryptoKit
import Foundation

// A video on a feedback message (docs/api.md#videos): it goes up first, then the message names it. The composer keeps
// it as one video with its length (`ComposerAttachments.keepsVideos`); before, with nothing here to send one, it went
// as four stills (Jai, Agent Pager, 2026-11-24: "when I attached a video, it showed up as 4 screenshots instead").

/// A video on a message, as the Worker takes it: its upload's `uri`, and what it is.
struct MessageVideo: Encodable, Equatable, Sendable {
    let uri: String
    let mimeType: String
    let size: Int
    // swiftlint:disable:next identifier_name
    let duration_ms: Int?
}

/// A video on its way with a message: its poster for the thumbnail, and its file to play.
struct PendingVideo: Equatable, Sendable {
    var poster: Data
    var clip: ChatVideoClip
}

/// Why a video did not go, in words for the person who attached it.
enum FeedbackVideoProblem: Error, Equatable {
    /// The Worker refused it, with its status.
    case refused(status: Int)
    /// Still over the limit after it was made smaller: its size then, in bytes.
    case tooLarge(bytes: Int)
    case unreadable
    case notSent

    var words: String {
        switch self {
        case .refused(status: 403):
            "Videos can't be sent from this account. Take the video off and send the rest."
        case .refused(status: 413), .tooLarge:
            "That video is too long to send: it is over \(FeedbackVideoFile.limitText) even made smaller. "
                + "Trim it and attach it again."
        case .refused(status: 415):
            "Only MP4 and QuickTime videos can be sent."
        case .refused(status: 429):
            "Too many videos are waiting to be sent. Try again in a few minutes."
        case .unreadable:
            "That video couldn't be read. Take it off and attach it again."
        case .refused, .notSent:
            "The video did not go up. Try again."
        }
    }
}

/// A video's file made ready for the Worker: MP4 or QuickTime, at most 50 MB. One over the limit, or of another kind,
/// is made again smaller as an MP4; one that is still too large is not sent, and the composer says so.
struct FeedbackVideoFile: Equatable, Sendable {
    /// The Worker's most for one video (`MAX_VIDEO_BYTES`).
    static let limit = 50 * 1024 * 1024
    /// The Worker's most videos on one message (`MAX_VIDEOS`).
    static let perMessage = 2
    static var limitText: String { "\(limit / (1024 * 1024)) MB" }
    /// Smaller each time: 720p, then the system's medium quality, about a third of that.
    static let smaller = [AVAssetExportPreset1280x720, AVAssetExportPresetMediumQuality]

    var url: URL
    var mimeType: String
    var size: Int
    /// Made here, so removed once it is sent; false for the composer's own file.
    var isCopy: Bool

    static func mimeType(of url: URL) -> String? {
        switch url.pathExtension.lowercased() {
        case "mov", "qt": "video/quicktime"
        case "mp4", "m4v": "video/mp4"
        default: nil
        }
    }

    static func size(of url: URL) -> Int? {
        (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
    }

    /// The file as it is when the Worker takes it; else the first smaller copy that it does.
    static func prepared(_ url: URL, limit: Int = FeedbackVideoFile.limit) async throws -> FeedbackVideoFile {
        guard let size = size(of: url), size > 0 else {
            throw FeedbackVideoProblem.unreadable
        }
        if let mimeType = mimeType(of: url), size <= limit {
            return FeedbackVideoFile(url: url, mimeType: mimeType, size: size, isCopy: false)
        }
        var smallest = size
        for preset in smaller {
            guard let copy = await export(url, preset: preset) else {
                continue
            }
            let made = self.size(of: copy) ?? 0
            if made > 0, made <= limit {
                return FeedbackVideoFile(url: copy, mimeType: "video/mp4", size: made, isCopy: true)
            }
            if made > 0 { smallest = min(smallest, made) }
            try? FileManager.default.removeItem(at: copy)
        }
        if size <= limit {
            // Of a kind the Worker won't take, and it could not be made into an MP4.
            throw FeedbackVideoProblem.unreadable
        }
        throw FeedbackVideoProblem.tooLarge(bytes: smallest)
    }

    private static func export(_ url: URL, preset: String) async -> URL? {
        guard let session = AVAssetExportSession(asset: AVURLAsset(url: url), presetName: preset) else {
            return nil
        }
        let copy = FileManager.default.temporaryDirectory
            .appending(path: "FeedbackKit-\(UUID().uuidString)").appendingPathExtension("mp4")
        do {
            try await session.export(to: copy, as: .mp4)
            return copy
        } catch {
            try? FileManager.default.removeItem(at: copy)
            return nil
        }
    }
}

extension FeedbackDirect {
    private struct Room: Encodable {
        let name: String
        let mimeType: String
        let size: Int
    }

    private struct Ticket: Decodable {
        let uploadUrl: String
        let uri: String
        let headers: [String: String]?
    }

    /// `POST /v2/feedback/uploads` asks for room, `PUT` sends the bytes with the same token: the answer is the `uri`
    /// the message then names in `videos`. Throws `FeedbackVideoProblem`.
    func upload(_ video: FeedbackVideoFile, name: String) async throws -> String {
        guard baseURL.scheme?.lowercased() == "https" else { throw FeedbackVideoProblem.notSent }
        do {
            var ask = URLRequest(url: baseURL.appending(path: "v2/feedback/uploads"), timeoutInterval: 15)
            ask.httpMethod = "POST"
            ask.httpBody = try JSONEncoder().encode(Room(name: name, mimeType: video.mimeType, size: video.size))
            ask.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let ticket = try JSONDecoder().decode(Ticket.self, from: try await authorized(ask, exchange: http.send))
            guard let target = URL(string: ticket.uploadUrl, relativeTo: baseURL)?.absoluteURL,
                  target.scheme?.lowercased() == "https", target.user == nil, target.password == nil
            else {
                throw FeedbackVideoProblem.notSent
            }
            guard let bytes = try? Data(contentsOf: video.url, options: .mappedIfSafe), !bytes.isEmpty else {
                throw FeedbackVideoProblem.unreadable
            }
            // The timeout is the longest silence, not the whole upload's time.
            var put = URLRequest(url: target, timeoutInterval: 60)
            put.httpMethod = "PUT"
            for (field, value) in ticket.headers ?? [:] {
                put.setValue(value, forHTTPHeaderField: field)
            }
            put.httpBody = bytes
            // The bearer only for the Worker's own origin, as for a screenshot.
            _ = try await authorized(put, authenticated: Self.sameOrigin(target, baseURL), exchange: http.send)
            return ticket.uri
        } catch let problem as FeedbackVideoProblem {
            throw problem
        } catch let refusal as FeedbackRefusal {
            throw FeedbackVideoProblem.refused(status: refusal.status)
        } catch {
            throw FeedbackVideoProblem.notSent
        }
    }

    /// Where fetched videos wait to be played: the app's temporary folder, which the system empties in its own time.
    static let videoFolder = FileManager.default.temporaryDirectory
        .appending(path: "FeedbackKit-videos", directoryHint: .isDirectory)

    /// Where the video at `uri` waits: named for a digest of its address, so the address is in no name or log.
    static func videoFile(uri: String, mimeType: String?) -> URL {
        let digest = SHA256.hash(data: Data(uri.utf8)).map { String(format: "%02x", $0) }.joined()
        let kind = mimeType?.lowercased() == "video/quicktime" ? "mov" : "mp4"
        return videoFolder.appending(path: digest).appendingPathExtension(kind)
    }

    /// The address the Worker gives a message's `index`th attachment (docs/api.md#direct, `worker/src/live.ts`).
    static func attachmentURI(chat: String, message: String, index: Int) -> String {
        "/v2/feedback/\(chat)/images/\(message)/\(index)"
    }

    /// A video just sent is kept as the one its message will show, so it is not fetched back straight after it went
    /// up. If the Worker names it otherwise it is fetched once, as any other.
    static func keepSent(_ file: URL, uri: String, mimeType: String) {
        let kept = videoFile(uri: uri, mimeType: mimeType)
        try? FileManager.default.createDirectory(at: videoFolder, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: kept)
        try? FileManager.default.moveItem(at: file, to: kept)
    }

    /// A sent message's video, fetched once to a file the viewer plays (`LiveScreenshotStrip.loadsVideos`).
    public func loadVideo(_ attachment: LiveAttachment) async -> Result<URL, ChatActionError> {
        await loadVideo(uri: attachment.uri, mimeType: attachment.mimeType)
    }

    func loadVideo(uri: String, mimeType: String?) async -> Result<URL, ChatActionError> {
        let file = Self.videoFile(uri: uri, mimeType: mimeType)
        if FeedbackVideoFile.size(of: file) ?? 0 > 0 {
            return .success(file)
        }
        do {
            let request = try screenshotRequest(uri)
            let data = try await authorized(request, authenticated: Self.sameOrigin(request.url!, baseURL)) { request in
                try await images.send(request)
            }
            guard !data.isEmpty else { throw URLError(.zeroByteResource) }
            try FileManager.default.createDirectory(at: Self.videoFolder, withIntermediateDirectories: true)
            try data.write(to: file, options: .atomic)
            return .success(file)
        } catch {
            return .failure(ChatActionError("Could not load this video."))
        }
    }
}
