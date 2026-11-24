// Package media saves what a sender attached to a claimed message on this Mac, so the coordinator and its builders
// can open it: the screenshots the claim carries inline, and the videos it only names, fetched one by one. An agent
// reads pictures, so with a video goes frames.swift, which makes stills from it on a stock Mac.
package media

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/jai/feedbackkit/rex-runner/internal/worker"
)

var imageExtensions = map[string]string{"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}

var videoExtensions = map[string]string{"video/mp4": "mp4", "video/quicktime": "mov"}

// FramesScriptName is saved beside a message's videos.
const FramesScriptName = "frames.swift"

// Video is one saved video and its length, when the app said it.
type Video struct {
	Path       string
	DurationMs *int64
}

// Saved is where a message's attachments are, and what could not be saved.
type Saved struct {
	Images       []string
	Videos       []Video
	FramesScript string
	Problems     []string
}

// Folder is where a chat's attachments are kept: beside the run folders, outside any of them, so a reaped run
// leaves them for the next builder of the same chat.
func Folder(runsDir, chat string) string {
	return filepath.Join(runsDir, "_shots", safe(chat))
}

// Save writes each screenshot and each video of a claimed message into folder. fetch answers a video's bytes by its
// index. One attachment that cannot be saved is named in Problems and the rest are still saved: the message is
// delivered either way, and says what is missing.
func Save(folder, message string, images []worker.ClaimImage, videos []worker.ClaimVideo, fetch func(index int) ([]byte, error)) Saved {
	var saved Saved
	if len(images) == 0 && len(videos) == 0 {
		return saved
	}
	if err := os.MkdirAll(folder, 0o755); err != nil {
		saved.Problems = append(saved.Problems, fmt.Sprintf("no folder for the attachments: %v", err))
		return saved
	}
	name := safe(message)
	for i, image := range images {
		ext, ok := imageExtensions[strings.ToLower(image.MediaType)]
		if !ok {
			saved.Problems = append(saved.Problems, fmt.Sprintf("screenshot %d is %q, not a picture", i+1, image.MediaType))
			continue
		}
		data, err := base64.StdEncoding.DecodeString(image.Data)
		if err != nil || len(data) == 0 {
			saved.Problems = append(saved.Problems, fmt.Sprintf("screenshot %d could not be read", i+1))
			continue
		}
		path := filepath.Join(folder, fmt.Sprintf("%s-%d.%s", name, i+1, ext))
		if err := os.WriteFile(path, data, 0o644); err != nil {
			saved.Problems = append(saved.Problems, fmt.Sprintf("screenshot %d could not be saved: %v", i+1, err))
			continue
		}
		saved.Images = append(saved.Images, path)
	}
	for i, video := range videos {
		ext, ok := videoExtensions[strings.ToLower(video.MediaType)]
		if !ok {
			saved.Problems = append(saved.Problems, fmt.Sprintf("video %d is %q, not MP4 or QuickTime", i+1, video.MediaType))
			continue
		}
		data, err := fetch(video.Index)
		if err != nil {
			saved.Problems = append(saved.Problems, fmt.Sprintf("video %d could not be fetched: %v", i+1, err))
			continue
		}
		path := filepath.Join(folder, fmt.Sprintf("%s-video-%d.%s", name, i+1, ext))
		if err := os.WriteFile(path, data, 0o644); err != nil {
			saved.Problems = append(saved.Problems, fmt.Sprintf("video %d could not be saved: %v", i+1, err))
			continue
		}
		saved.Videos = append(saved.Videos, Video{Path: path, DurationMs: video.DurationMs})
	}
	if len(saved.Videos) > 0 {
		script := filepath.Join(folder, FramesScriptName)
		if err := os.WriteFile(script, []byte(framesScript), 0o644); err == nil {
			saved.FramesScript = script
		}
	}
	return saved
}

// Note is what the coordinator reads after a message's words, and hands its builders: each file's path, a video's
// length, and how to make stills from a video to look at. Empty when the message had no attachment.
func (s Saved) Note() string {
	var parts []string
	if len(s.Images) > 0 {
		what := "screenshot"
		if len(s.Images) > 1 {
			what = fmt.Sprintf("%d screenshots", len(s.Images))
		}
		parts = append(parts, fmt.Sprintf("%s, open each and look at it before answering: %s", what, strings.Join(s.Images, ", ")))
	}
	if len(s.Videos) > 0 {
		files := make([]string, 0, len(s.Videos))
		for _, v := range s.Videos {
			if length := DurationText(v.DurationMs); length != "" {
				files = append(files, fmt.Sprintf("%s (%s)", v.Path, length))
			} else {
				files = append(files, v.Path)
			}
		}
		what := "video"
		if len(s.Videos) > 1 {
			what = fmt.Sprintf("%d videos", len(s.Videos))
		}
		look := "make stills from it and open them: `ffmpeg -loglevel error -i <video> -vf fps=1 -frames:v 30 <folder>/%03d.png` when ffmpeg is on PATH"
		if s.FramesScript != "" {
			look += fmt.Sprintf(", else `swift %s <video> <folder>` (one still a second, at most 30)", s.FramesScript)
		}
		parts = append(parts, fmt.Sprintf("%s: %s; to see one, %s", what, strings.Join(files, ", "), look))
	}
	if len(s.Problems) > 0 {
		parts = append(parts, "NOT saved: "+strings.Join(s.Problems, "; "))
	}
	return strings.Join(parts, " | ")
}

// DurationText is a video's length as the app shows it: "0:07", "1:05", "1:02:03". Empty when the app did not say.
func DurationText(ms *int64) string {
	if ms == nil || *ms < 0 {
		return ""
	}
	total := *ms / 1000
	hours, minutes, seconds := total/3600, total%3600/60, total%60
	if hours > 0 {
		return fmt.Sprintf("%d:%02d:%02d", hours, minutes, seconds)
	}
	return fmt.Sprintf("%d:%02d", minutes, seconds)
}

// safe keeps a chat's or a message's id to what a file name takes; the Worker's ids are these characters already.
func safe(id string) string {
	var b strings.Builder
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	if b.Len() == 0 {
		return "message"
	}
	return b.String()
}

// Stills from a video with AVFoundation, as runner/feedbackkit_runner/videos.py saves it for the Orca runner.
const framesScript = `// Stills from a video, for an agent to look at, with AVFoundation (stock macOS, no ffmpeg):
//   swift frames.swift <video> <folder> [count]
// One still a second, at most 30, unless ` + "`count`" + ` says; each a PNG named for its time. Prints each still's path.
import AVFoundation
import ImageIO
import UniformTypeIdentifiers

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
    FileHandle.standardError.write(Data("usage: swift frames.swift <video> <folder> [count]\n".utf8))
    exit(2)
}
do {
    let asset = AVURLAsset(url: URL(fileURLWithPath: arguments[1]))
    let folder = URL(fileURLWithPath: arguments[2], isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let seconds = try await asset.load(.duration).seconds
    guard seconds > 0 else {
        FileHandle.standardError.write(Data("frames.swift: that video has no length\n".utf8))
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
            FileHandle.standardError.write(Data("frames.swift: could not write \(still.path)\n".utf8))
            exit(1)
        }
        print(still.path)
    }
} catch {
    FileHandle.standardError.write(Data("frames.swift: \(error.localizedDescription)\n".utf8))
    exit(1)
}
`
