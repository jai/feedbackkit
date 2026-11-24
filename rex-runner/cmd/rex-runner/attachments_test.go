package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jai/feedbackkit/rex-runner/internal/inbox"
	"github.com/jai/feedbackkit/rex-runner/internal/worker"
)

// A message with a screenshot and a video, claimed: both are on this Mac, and the coordinator's inbox says where.
func TestAClaimedMessagesScreenshotAndVideoReachTheCoordinatorAsFiles(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/runner/claim":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "text": "Look at the video", "first": true, "title": "Video",
				"images": []map[string]any{{"media_type": "image/jpeg", "data": base64.StdEncoding.EncodeToString([]byte("a still"))}},
				"videos": []map[string]any{{"index": 1, "media_type": "video/mp4", "size": 6, "duration_ms": 7000}},
			})
		case "/runner/media":
			var body struct {
				Chat    string `json:"chat"`
				Message string `json:"message"`
				Index   int    `json:"index"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Chat != "fb_1" || body.Message != "m_1" || body.Index != 1 {
				http.Error(w, "no such media", http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("a film"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	runs := t.TempDir()
	wc := worker.NewClient(srv.URL, "tok")
	item := worker.WorkItem{Chat: "fb_1", Message: "m_1", App: "agent-pager", Login: "jai", Repo: "jai/agent-pager", Role: "owner", First: true}
	claimed, err := wc.Claim(context.Background(), item)
	if err != nil || claimed == nil {
		t.Fatalf("claim: %+v %v", claimed, err)
	}
	if len(claimed.Images) != 1 || len(claimed.Videos) != 1 || claimed.Videos[0].Index != 1 {
		t.Fatalf("the claim's screenshots and videos were dropped: %+v", claimed)
	}

	note := claimedAttachments(context.Background(), runs, wc, item, claimed)
	still := filepath.Join(runs, "_shots", "fb_1", "m_1-1.jpg")
	film := filepath.Join(runs, "_shots", "fb_1", "m_1-video-1.mp4")
	if got, err := os.ReadFile(still); err != nil || string(got) != "a still" {
		t.Fatalf("the screenshot is not on disk: %q %v", got, err)
	}
	if got, err := os.ReadFile(film); err != nil || string(got) != "a film" {
		t.Fatalf("the video is not on disk: %q %v", got, err)
	}
	if !strings.Contains(note, still) || !strings.Contains(note, film+" (0:07)") {
		t.Fatalf("the note does not say where they are:\n%s", note)
	}

	formatted := inbox.FormatBatch([]inbox.Event{{Kind: "new_chat", ChatID: "fb_1", Summary: "jai (owner): Look at the video", Attachments: note}})
	if !strings.Contains(formatted, "attached: ") || !strings.Contains(formatted, film) {
		t.Fatalf("the coordinator is not told of the files:\n%s", formatted)
	}
}

func TestAClaimedMessageWithNoAttachmentSaysNothingOfAny(t *testing.T) {
	runs := t.TempDir()
	note := claimedAttachments(context.Background(), runs, worker.NewClient("http://127.0.0.1:1", "tok"),
		worker.WorkItem{Chat: "fb_1", Message: "m_1"}, &worker.ClaimResponse{Chat: "fb_1", Text: "Words only"})
	if note != "" {
		t.Fatalf("note: %q", note)
	}
	if formatted := inbox.FormatBatch([]inbox.Event{{Kind: "user_reply", Summary: "words"}}); strings.Contains(formatted, "attached") {
		t.Fatalf("an event with no attachment says it has some:\n%s", formatted)
	}
}
