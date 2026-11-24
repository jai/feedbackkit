import AgentChatKit
import AgentChatLive
@testable import FeedbackKit
import Foundation
import Testing

/// A video on a message, off the device: what the Worker is sent, and what the composer says when it can't go.
struct FeedbackVideoTests {
    @Test func aMessageWithNoVideoSendsNoVideosAtAll() throws {
        let message = FeedbackMessage(text: "Words", build: "7", images: [], client_ref: "once")
        let body = try JSONValue.decode(JSONEncoder().encode(message))
        #expect(body["videos"] == nil, "a host's own backend and an older Worker get the body they always got")
        #expect(body["images"]?.array?.isEmpty == true)
    }

    @Test func aMessageNamesItsVideoAsTheWorkerTakesIt() throws {
        let video = MessageVideo(uri: "/v2/feedback/uploads/up_1", mimeType: "video/mp4", size: 1234, duration_ms: 9500)
        let message = FeedbackMessage(text: "", build: nil, images: [], videos: [video], client_ref: "once")
        let sent = try #require(JSONValue.decode(JSONEncoder().encode(message))["videos"]?.array?.first)
        #expect(sent["uri"]?.string == "/v2/feedback/uploads/up_1")
        #expect(sent["mimeType"]?.string == "video/mp4")
        #expect(sent["size"]?.int == 1234)
        #expect(sent["duration_ms"]?.int == 9500)
    }

    @Test func aVideosKindIsReadFromItsName() {
        #expect(FeedbackVideoFile.mimeType(of: URL(fileURLWithPath: "/tmp/a.MOV")) == "video/quicktime")
        #expect(FeedbackVideoFile.mimeType(of: URL(fileURLWithPath: "/tmp/a.mp4")) == "video/mp4")
        #expect(FeedbackVideoFile.mimeType(of: URL(fileURLWithPath: "/tmp/a.m4v")) == "video/mp4")
        #expect(FeedbackVideoFile.mimeType(of: URL(fileURLWithPath: "/tmp/a.avi")) == nil)
    }

    @Test func eachWayAVideoDoesNotGoSaysWhy() {
        #expect(FeedbackVideoProblem.refused(status: 403).words.contains("can't be sent from this account"))
        #expect(FeedbackVideoProblem.refused(status: 413).words.contains("50 MB"))
        #expect(FeedbackVideoProblem.tooLarge(bytes: 80_000_000).words.contains("50 MB"))
        #expect(FeedbackVideoProblem.refused(status: 415).words == "Only MP4 and QuickTime videos can be sent.")
        #expect(FeedbackVideoProblem.refused(status: 429).words.contains("waiting to be sent"))
        #expect(FeedbackVideoProblem.unreadable.words.contains("couldn't be read"))
        #expect(FeedbackVideoProblem.notSent.words == FeedbackVideoProblem.refused(status: 500).words)
    }

    @Test func aMessageOnItsWayShowsItsPicturesThenItsVideosAsTheSentOneWill() {
        let clip = ChatVideoClip(url: URL(fileURLWithPath: "/tmp/a.mov"), duration: .seconds(7))
        let pending = PendingMessage(text: "", screenshots: 2, images: [Data([1])],
                                     videos: [PendingVideo(poster: Data([2]), clip: clip)])
        #expect(pending.media.count == 2)
        guard case let .picture(picture) = pending.media[0], case let .video(poster, shown) = pending.media[1] else {
            Issue.record("pictures first, then videos")
            return
        }
        #expect(picture == Data([1]))
        #expect(poster == Data([2]))
        #expect(shown == clip)
    }

    @Test func aSentVideosFileIsNamedForADigestOfItsAddress() {
        let uri = FeedbackDirect.attachmentURI(chat: "chat-1", message: "m1", index: 2)
        #expect(uri == "/v2/feedback/chat-1/images/m1/2")
        let file = FeedbackDirect.videoFile(uri: uri, mimeType: "video/quicktime")
        #expect(file.pathExtension == "mov")
        #expect(!file.lastPathComponent.contains("chat-1"))
        #expect(file == FeedbackDirect.videoFile(uri: uri, mimeType: "video/quicktime"))
        #expect(FeedbackDirect.videoFile(uri: uri, mimeType: "video/mp4").pathExtension == "mp4")
    }
}
