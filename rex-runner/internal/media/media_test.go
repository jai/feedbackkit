package media

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jai/feedbackkit/rex-runner/internal/worker"
)

func ms(v int64) *int64 { return &v }

func TestSaveWritesEachScreenshotAndFetchedVideoAndTheNoteNamesThem(t *testing.T) {
	folder := Folder(t.TempDir(), "fb_0f0ef8e46df8980c")
	images := []worker.ClaimImage{
		{MediaType: "image/jpeg", Data: base64.StdEncoding.EncodeToString([]byte("jpeg one"))},
		{MediaType: "image/png", Data: base64.StdEncoding.EncodeToString([]byte("png two"))},
	}
	videos := []worker.ClaimVideo{{Index: 2, MediaType: "video/quicktime", DurationMs: ms(12_400)}}
	asked := []int{}
	saved := Save(folder, "m_1", images, videos, func(index int) ([]byte, error) {
		asked = append(asked, index)
		return []byte("a film"), nil
	})

	if len(saved.Problems) != 0 {
		t.Fatalf("problems: %v", saved.Problems)
	}
	if len(asked) != 1 || asked[0] != 2 {
		t.Fatalf("the video is fetched once, by the index its claim names: %v", asked)
	}
	want := map[string]string{
		filepath.Join(folder, "m_1-1.jpg"):       "jpeg one",
		filepath.Join(folder, "m_1-2.png"):       "png two",
		filepath.Join(folder, "m_1-video-1.mov"): "a film",
	}
	for path, content := range want {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != content {
			t.Fatalf("%s: %q, %v", path, got, err)
		}
	}
	if len(saved.Images) != 2 || len(saved.Videos) != 1 || saved.Videos[0].Path != filepath.Join(folder, "m_1-video-1.mov") {
		t.Fatalf("saved: %+v", saved)
	}
	script, err := os.ReadFile(saved.FramesScript)
	if err != nil || !strings.Contains(string(script), "AVAssetImageGenerator") {
		t.Fatalf("frames.swift goes with a video: %v", err)
	}

	note := saved.Note()
	for _, part := range []string{
		"2 screenshots", filepath.Join(folder, "m_1-1.jpg"), filepath.Join(folder, "m_1-2.png"),
		"video: " + filepath.Join(folder, "m_1-video-1.mov") + " (0:12)", "ffmpeg", "swift " + saved.FramesScript,
	} {
		if !strings.Contains(note, part) {
			t.Fatalf("the note leaves out %q:\n%s", part, note)
		}
	}
}

func TestAMessageWithNoAttachmentSavesNothingAndSaysNothing(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "none")
	saved := Save(folder, "m_1", nil, nil, func(int) ([]byte, error) { return nil, errors.New("not asked") })
	if saved.Note() != "" {
		t.Fatalf("note: %q", saved.Note())
	}
	if _, err := os.Stat(folder); !os.IsNotExist(err) {
		t.Fatalf("a folder was made for nothing: %v", err)
	}
}

func TestWhatCannotBeSavedIsNamedAndTheRestIsStillSaved(t *testing.T) {
	folder := t.TempDir()
	images := []worker.ClaimImage{
		{MediaType: "image/jpeg", Data: "not base64 !!"},
		{MediaType: "text/html", Data: "PGI+"},
		{MediaType: "image/jpeg", Data: base64.StdEncoding.EncodeToString([]byte("good"))},
	}
	videos := []worker.ClaimVideo{{Index: 3, MediaType: "video/mp4"}, {Index: 4, MediaType: "video/x-msvideo"}}
	saved := Save(folder, "m/../1", images, videos, func(int) ([]byte, error) { return nil, errors.New("status 404") })

	if len(saved.Images) != 1 || saved.Images[0] != filepath.Join(folder, "m____1-3.jpg") {
		t.Fatalf("the good screenshot keeps its place and stays in the folder: %v", saved.Images)
	}
	if len(saved.Videos) != 0 || saved.FramesScript != "" {
		t.Fatalf("no video was saved: %+v", saved)
	}
	if len(saved.Problems) != 4 {
		t.Fatalf("each one that did not save is named: %v", saved.Problems)
	}
	note := saved.Note()
	if !strings.Contains(note, "NOT saved") || !strings.Contains(note, "video 1 could not be fetched: status 404") {
		t.Fatalf("note: %s", note)
	}
}

func TestDurationTextReadsAsTheAppShowsIt(t *testing.T) {
	for want, v := range map[string]*int64{"": nil, "0:07": ms(7_900), "1:05": ms(65_000), "1:02:03": ms(3_723_000)} {
		if got := DurationText(v); got != want {
			t.Fatalf("%v: %q, want %q", v, got, want)
		}
	}
}
