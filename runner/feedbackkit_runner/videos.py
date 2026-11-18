"""A message's videos on the builder (jai/feedbackkit#4): the runner fetches each with `/runner/media`, saves it next to
the screenshots, and tells the agent its file, its length and how to look at it. An agent reads pictures, so it makes
stills: with ffmpeg when the builder has it, else with FRAMES_SCRIPT, AVFoundation through `swift`, which a stock Mac
with Xcode's command line tools runs."""

from __future__ import annotations

VIDEO_EXTENSIONS = {"video/mp4": "mp4", "video/quicktime": "mov"}

# Saved beside the videos as frames.swift: `swift frames.swift <video> <folder> [count]`.
FRAMES_SCRIPT_NAME = "frames.swift"
FRAMES_SCRIPT = """// Stills from a video, for an agent to look at, with AVFoundation (stock macOS, no ffmpeg):
//   swift frames.swift <video> <folder> [count]
// One still a second, at most 30, unless `count` says; each a PNG named for its time. Prints each still's path.
import AVFoundation
import ImageIO
import UniformTypeIdentifiers

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
    FileHandle.standardError.write(Data("usage: swift frames.swift <video> <folder> [count]\\n".utf8))
    exit(2)
}
do {
    let asset = AVURLAsset(url: URL(fileURLWithPath: arguments[1]))
    let folder = URL(fileURLWithPath: arguments[2], isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let seconds = try await asset.load(.duration).seconds
    guard seconds > 0 else {
        FileHandle.standardError.write(Data("frames.swift: that video has no length\\n".utf8))
        exit(1)
    }
    let count = arguments.count > 3 ? max(1, Int(arguments[3]) ?? 1) : min(30, max(1, Int(seconds.rounded(.up))))
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 1568, height: 1568)
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    for index in 0..<count {
        let time = CMTime(seconds: seconds * (Double(index) + 0.5) / Double(count), preferredTimescale: 600)
        let (image, actual) = try await generator.image(at: time)
        let still = folder.appending(path: String(format: "%03d-%.1fs.png", index + 1, actual.seconds))
        let destination = CGImageDestinationCreateWithURL(still as CFURL, UTType.png.identifier as CFString, 1, nil)
        if let destination { CGImageDestinationAddImage(destination, image, nil) }
        guard let destination, CGImageDestinationFinalize(destination) else {
            FileHandle.standardError.write(Data("frames.swift: could not write \\(still.path)\\n".utf8))
            exit(1)
        }
        print(still.path)
    }
} catch {
    FileHandle.standardError.write(Data("frames.swift: \\(error.localizedDescription)\\n".utf8))
    exit(1)
}
"""


def duration_text(duration_ms: object) -> str | None:
    """ "0:07", "1:05", "1:02:03": a video's length as the app shows it; None when the app did not say."""
    if not isinstance(duration_ms, int) or isinstance(duration_ms, bool) or duration_ms < 0:
        return None
    total = duration_ms // 1000
    hours, minutes, seconds = total // 3600, total % 3600 // 60, total % 60
    return f"{hours:d}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes:d}:{seconds:02d}"


def video_note(videos: list[tuple[str, object]], sender: str, script: str) -> str:
    """What the agent reads after a message's words: each video's file and length, and how to make stills from it to
    look at before answering. `videos` is (path, duration_ms) each; `script` is where frames.swift is."""
    what = "a video" if len(videos) == 1 else f"{len(videos):d} videos"
    files = ", ".join(
        f"{path} ({length})" if (length := duration_text(duration)) else path for path, duration in videos
    )
    return (
        f"\n\n[{sender} attached {what}: {files}. Look at each before you answer. To see one, make stills from it"
        " and open them: `ffmpeg -loglevel error -i <video> -vf fps=1 -frames:v 30 <folder>/%03d.png` when ffmpeg is"
        f" on PATH, else `swift {script} <video> <folder>` (AVFoundation: one still a second, at most 30).]"
    )
