import AgentChatKit
import AgentChatLive
import AVFoundation
import DurableNetworking
@testable import FeedbackKit
import FeedbackKitTestSupport
import Foundation
import Testing

/// A video attached to feedback arrives as a video (Jai, Agent Pager, 2026-11-24: "when I attached a video, it showed
/// up as 4 screenshots instead"): the composer keeps it as one, it goes up before its message, the message names it,
/// and when it can't go the composer says why and keeps it.
@MainActor
@Suite(.serialized)
struct FeedbackVideoSendTests {
    /// A two-second H.264 film of 160×120 frames, written to a temporary file.
    private func film() async throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).mov")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 160, AVVideoHeightKey: 120,
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
            kCVPixelBufferWidthKey as String: 160, kCVPixelBufferHeightKey as String: 120,
        ])
        writer.add(input)
        #expect(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<20 {
            while !input.isReadyForMoreMediaData {
                try await Task.sleep(for: .milliseconds(5))
            }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, try #require(adaptor.pixelBufferPool), &buffer)
            let pixels = try #require(buffer)
            CVPixelBufferLockBaseAddress(pixels, [])
            memset(CVPixelBufferGetBaseAddress(pixels), Int32(frame * 12), CVPixelBufferGetDataSize(pixels))
            CVPixelBufferUnlockBaseAddress(pixels, [])
            #expect(adaptor.append(pixels, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 10)))
        }
        input.markAsFinished()
        await writer.finishWriting()
        #expect(writer.status == .completed)
        return url
    }

    private func directModel(_ rest: DirectHTTP) -> FeedbackRequestsModel {
        FeedbackRequestsModel(client: FeedbackClient(direct: FeedbackDirect(
            baseURL: URL(string: "https://worker.test")!, token: { _ in "fixture" }, http: rest, streams: rest, images: rest
        )), defaults: nil)
    }

    @Test func straightToTheWorkerAVideoStaysOneVideoWithItsLength() async throws {
        let url = try await film()
        defer { try? FileManager.default.removeItem(at: url) }
        let model = directModel(DirectHTTP())
        let route = model.compose(reusing: nil)
        let attachments = model.attachments(for: route.box)
        await attachments.add(video: url)
        #expect(attachments.images.count == 1, "the video was added as \(attachments.images.count) attachments")
        let clip = try #require(attachments.images.first?.video, "the video became stills")
        #expect(clip.duration > .seconds(1))
        ComposerAttachments.discard(attachments.take())
    }

    /// Through a host's own backend, and to an issue, nothing takes a video: there it is stills, as it always was.
    @Test func whereNothingTakesAVideoItIsStillStills() async throws {
        let url = try await film()
        defer { try? FileManager.default.removeItem(at: url) }
        let proxy = FeedbackRequestsModel(client: FeedbackHTTP().client, defaults: nil)
        let attachments = proxy.attachments(for: proxy.compose(reusing: nil).box)
        await attachments.add(video: url)
        #expect(attachments.images.count == ComposerVideo.stills)
        #expect(attachments.images.allSatisfy { $0.video == nil })

        let issues = directModel(DirectHTTP(list: #"{"threads":[],"builderOnline":true,"notice":"Opens a public issue."}"#))
        await issues.refresh()
        #expect(!issues.sendsVideos)
        #expect(!issues.attachments(for: issues.compose(reusing: nil).box).keepsVideos)
    }

    @Test func aVideoGoesUpBeforeItsMessageWhichNamesItAndSendsNoStillOfIt() async throws {
        let url = try await film()
        defer { try? FileManager.default.removeItem(at: url) }
        let rest = DirectHTTP()
        let model = directModel(rest)
        let route = model.compose(reusing: nil)
        await model.attachments(for: route.box).add(video: url)
        let kept = try #require(model.attachments(for: route.box).images.first?.video)
        let bytes = try Data(contentsOf: kept.url)
        await model.send(route)
        #expect(model.error == nil)

        let requests = await rest.requests.filter { $0.httpMethod != nil && $0.httpMethod != "GET" }
        #expect(requests.map { "\($0.httpMethod ?? "") \($0.url!.path)" } == [
            "POST /v2/feedback/uploads", "PUT /v2/feedback/uploads/up_1", "POST /v2/feedback",
        ])
        let room = try JSONValue.decode(#require(requests[0].httpBody))
        #expect(room["mimeType"]?.string == "video/quicktime")
        #expect(room["size"]?.int == bytes.count)
        #expect(requests[1].httpBody == bytes, "the video's own bytes go up")
        #expect(requests[1].value(forHTTPHeaderField: "Content-Type") == "video/quicktime")
        #expect(requests[1].value(forHTTPHeaderField: "Authorization") == "Bearer fixture")
        let message = try JSONValue.decode(#require(requests[2].httpBody))
        let video = try #require(message["videos"]?.array?.first, "the message names no video")
        #expect(message["videos"]?.array?.count == 1)
        #expect(video["uri"]?.string == "/v2/feedback/uploads/up_1")
        #expect(video["mimeType"]?.string == "video/quicktime")
        #expect(video["size"]?.int == bytes.count)
        #expect((video["duration_ms"]?.int ?? 0) > 1000)
        #expect(message["images"]?.array?.isEmpty == true, "its poster went as a screenshot")
        #expect(model.attachments(for: route.box).isEmpty)
        #expect(!FileManager.default.fileExists(atPath: kept.url.path), "the tray's copy stayed after it was sent")
    }

    @Test func aPictureAndAVideoGoTogetherThePictureInTheMessageTheVideoNamed() async throws {
        let url = try await film()
        defer { try? FileManager.default.removeItem(at: url) }
        let rest = DirectHTTP()
        let model = directModel(rest)
        let route = model.compose(reusing: nil)
        let attachments = model.attachments(for: route.box)
        await attachments.add(video: url)
        let poster = try #require(attachments.images.first?.jpeg)
        await attachments.add(poster)
        #expect(attachments.images.count == 2)
        await model.send(route)
        let message = try JSONValue.decode(#require(await rest.requests("POST", "/v2/feedback").first?.httpBody))
        #expect(message["images"]?.array?.count == 1)
        #expect(message["videos"]?.array?.count == 1)
    }

    /// The upload went and the message did not: sent again, it names the video that is up and keeps its
    /// `client_ref`, so neither the video nor the message lands twice.
    @Test func aSendTriedAgainDoesNotPutTheVideoUpASecondTime() async throws {
        let url = try await film()
        defer { try? FileManager.default.removeItem(at: url) }
        let rest = DirectHTTP(statuses: [200, 200, 500])
        let model = directModel(rest)
        let route = model.compose(reusing: nil)
        model.drafts[route.box] = "Look at this"
        await model.attachments(for: route.box).add(video: url)
        await model.send(route)
        #expect(model.error == "Could not send feedback. Try again.")
        #expect(model.draft(for: route.box) == "Look at this")
        #expect(model.attachments(for: route.box).images.first?.video != nil, "the video left the tray")

        await model.send(route)
        #expect(model.error == nil)
        #expect(await rest.requests("POST", "/v2/feedback/uploads").count == 1)
        #expect(await rest.requests("PUT", "/v2/feedback/uploads/up_1").count == 1)
        let messages = await rest.requests("POST", "/v2/feedback")
        #expect(messages.count == 2)
        let first = try JSONValue.decode(#require(messages[0].httpBody))
        let second = try JSONValue.decode(#require(messages[1].httpBody))
        #expect(first["client_ref"] == second["client_ref"])
        #expect(second["videos"]?.array?.first?["uri"]?.string == "/v2/feedback/uploads/up_1")
        ComposerAttachments.discard(model.attachments(for: route.box).take())
    }

    @Test(arguments: [(403, "can't be sent from this account"), (413, "50 MB"), (415, "MP4 and QuickTime"),
                      (429, "waiting to be sent"), (500, "did not go up")])
    func aVideoTheWorkerRefusesSaysWhyAndStaysInTheTray(status: Int, words: String) async throws {
        let url = try await film()
        defer { try? FileManager.default.removeItem(at: url) }
        let rest = DirectHTTP(statuses: [status])
        let model = directModel(rest)
        let route = model.compose(reusing: nil)
        model.drafts[route.box] = "Look at this"
        await model.attachments(for: route.box).add(video: url)
        await model.send(route)
        #expect(model.error?.contains(words) == true, "\(model.error ?? "no reason given")")
        #expect(model.draft(for: route.box) == "Look at this")
        #expect(model.attachments(for: route.box).images.first?.video != nil)
        #expect(await rest.requests("POST", "/v2/feedback").isEmpty, "the message went without its video")
        ComposerAttachments.discard(model.attachments(for: route.box).take())
    }

    @Test func aVideoWithinTheLimitGoesAsItIsAndOneStillTooLargeMadeSmallerSaysSo() async throws {
        let url = try await film()
        defer { try? FileManager.default.removeItem(at: url) }
        let size = try #require(FeedbackVideoFile.size(of: url))
        let whole = try await FeedbackVideoFile.prepared(url, limit: size)
        #expect(whole == FeedbackVideoFile(url: url, mimeType: "video/quicktime", size: size, isCopy: false))

        await #expect(throws: FeedbackVideoProblem.self) { try await FeedbackVideoFile.prepared(url, limit: 16) }
        let model = directModel(DirectHTTP())
        model.prepareVideo = { try await FeedbackVideoFile.prepared($0, limit: 16) }
        let route = model.compose(reusing: nil)
        await model.attachments(for: route.box).add(video: url)
        await model.send(route)
        #expect(model.error?.contains("too long to send") == true, "\(model.error ?? "no reason given")")
        #expect(model.attachments(for: route.box).images.count == 1, "it stays in the tray, to trim or take off")
        ComposerAttachments.discard(model.attachments(for: route.box).take())
    }

    /// Over the limit, a video is made again smaller and that copy goes up; the copy is removed after.
    @Test func aVideoOverTheLimitGoesUpAsTheSmallerCopy() async throws {
        let url = try await film()
        defer { try? FileManager.default.removeItem(at: url) }
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).mp4")
        try Data("smaller".utf8).write(to: copy)
        let rest = DirectHTTP()
        let model = directModel(rest)
        model.prepareVideo = { _ in FeedbackVideoFile(url: copy, mimeType: "video/mp4", size: 7, isCopy: true) }
        let route = model.compose(reusing: nil)
        await model.attachments(for: route.box).add(video: url)
        await model.send(route)
        #expect(model.error == nil)
        #expect(await rest.requests("PUT", "/v2/feedback/uploads/up_1").first?.httpBody == Data("smaller".utf8))
        let message = try JSONValue.decode(#require(await rest.requests("POST", "/v2/feedback").first?.httpBody))
        #expect(message["videos"]?.array?.first?["mimeType"]?.string == "video/mp4")
        #expect(message["videos"]?.array?.first?["size"]?.int == 7)
        #expect(!FileManager.default.fileExists(atPath: copy.path))
    }

    @Test func aSentVideoIsFetchedOnceToAFileThePlayerOpens() async throws {
        let rest = DirectHTTP(media: Data("a film".utf8))
        let direct = FeedbackDirect(baseURL: URL(string: "https://worker.test")!, token: { _ in "fixture" },
                                    http: rest, streams: rest, images: rest)
        let uri = "/v2/feedback/chat-\(UUID().uuidString)/images/m1/0"
        let file = try await direct.loadVideo(uri: uri, mimeType: "video/mp4").get()
        defer { try? FileManager.default.removeItem(at: file) }
        #expect(try Data(contentsOf: file) == Data("a film".utf8))
        #expect(file.pathExtension == "mp4")
        #expect(try await direct.loadVideo(uri: uri, mimeType: "video/mp4").get() == file)
        let fetches = await rest.requests
        #expect(fetches.count == 1, "fetched again though it was kept")
        #expect(fetches.first?.value(forHTTPHeaderField: "Authorization") == "Bearer fixture")
    }

    /// The video just sent is the file its message shows: it is not fetched back straight after it went up.
    @Test func theVideoJustSentIsNotFetchedBack() async throws {
        let url = try await film()
        defer { try? FileManager.default.removeItem(at: url) }
        let chat = "chat-\(UUID().uuidString)"
        let rest = DirectHTTP(chat: #"{"id":"\#(chat)","isWorking":true,"builderOnline":true,"messages":["#
            + #"{"id":"m1","role":"you","text":"","anchor":null,"images":1,"status":"pending"}]}"#)
        let model = directModel(rest)
        let route = model.compose(reusing: nil)
        await model.attachments(for: route.box).add(video: url)
        await model.send(route)
        #expect(model.error == nil)
        let direct = try #require(model.client.direct)
        let uri = FeedbackDirect.attachmentURI(chat: chat, message: "m1", index: 0)
        let before = await rest.requests.count
        let file = try await direct.loadVideo(uri: uri, mimeType: "video/quicktime").get()
        defer { try? FileManager.default.removeItem(at: file) }
        #expect(await rest.requests.count == before, "the video was fetched back after it went up")
        #expect(await ComposerVideoProbe.plays(file))
    }
}

private enum ComposerVideoProbe {
    static func plays(_ url: URL) async -> Bool {
        ((try? await AVURLAsset(url: url).load(.duration).seconds) ?? 0) > 0
    }
}
