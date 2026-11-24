package worker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWorkerClientPollWaitClaimResult(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "unauth", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/runner/wait":
			_ = json.NewEncoder(w).Encode(map[string]any{"seq": 7})
		case "/runner/poll":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"work": []map[string]any{
					{"chat": "fb-1", "message": "m-1", "app": "prhub", "login": "jai", "repo": "jai/prhub", "role": "owner", "first": true},
				},
			})
		case "/runner/claim":
			// The Worker's claim answers the message only (docs/worker.md), not whose it is.
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "text": "Fix font", "first": true, "title": "Font"})
		case "/runner/result":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
		case "/runner/rex-status":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
		case "/runner/rex-inspect":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
		case "/runner/agent":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "tok")
	seq, ok, err := c.Wait(context.Background(), nil, time.Second)
	if err != nil || !ok || seq != 7 {
		t.Fatalf("wait: seq=%d ok=%v err=%v", seq, ok, err)
	}
	work, err := c.Poll(context.Background(), true, "")
	if err != nil || len(work) != 1 || work[0].Chat != "fb-1" || !work[0].First {
		t.Fatalf("poll: %+v err=%v", work, err)
	}
	claimed, err := c.Claim(context.Background(), work[0])
	if err != nil || claimed == nil || claimed.Text != "Fix font" {
		t.Fatalf("claim: %+v err=%v", claimed, err)
	}
	if claimed.Chat != "fb-1" || claimed.App != "prhub" || claimed.Login != "jai" || claimed.Repo != "jai/prhub" || claimed.Role != "owner" {
		t.Fatalf("claim identity from the work item: %+v", claimed)
	}
	if err := c.Result(context.Background(), work[0], "delivered", ""); err != nil {
		t.Fatalf("result: %v", err)
	}
	if err := c.PushRexStatus(context.Background(), RexStatusPayload{
		SessionName:       "feedback-loop",
		SessionActive:     true,
		CoordinatorActive: true,
		CoordinatorState:  "idle",
		DaemonRunning:     true,
	}); err != nil {
		t.Fatalf("push rex status: %v", err)
	}
	if err := c.PushRexInspect(context.Background(), RexInspectPayload{
		SessionName: "feedback-loop",
		Panes:       []RexInspectPane{{ID: "fable-coordinator", Label: "Fable", Kind: "coordinator", Status: "idle", Capture: "ready"}},
	}); err != nil {
		t.Fatalf("push rex inspect: %v", err)
	}
	if err := c.PostAgent(context.Background(), AgentSidePayload{
		App:       "prhub",
		Login:     "jai",
		Chat:      "fb-1",
		Messages:  []AgentMessage{{ID: "r-1", Text: "On it!", At: time.Now().UTC().Format(time.RFC3339)}},
		IsWorking: false,
	}); err != nil {
		t.Fatalf("post agent: %v", err)
	}
}

func TestAgentSideSaysItAsksOnlyWhenItDoes(t *testing.T) {
	side := func(asks bool) map[string]any {
		t.Helper()
		raw, err := json.Marshal(AgentSidePayload{App: "prhub", Login: "jai", Chat: "fb-1", Messages: []AgentMessage{}, Asks: asks})
		if err != nil {
			t.Fatal(err)
		}
		var out map[string]any
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	if got := side(true); got["asks"] != true {
		t.Fatalf("a question: %v", got)
	}
	if _, sent := side(false)["asks"]; sent {
		t.Fatal("no question: the key is left out, as a Worker before `asks` expects")
	}
}

// A claim's screenshots come inline and its videos by name; Media asks for one video's bytes by its index.
func TestClaimKeepsScreenshotsAndVideosAndMediaFetchesAVideo(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/runner/claim":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "text": "", "first": false, "title": "Video",
				"images": []map[string]any{{"media_type": "image/jpeg", "data": "YQ=="}},
				"videos": []map[string]any{{"index": 1, "media_type": "video/quicktime", "size": 3, "duration_ms": 1500}},
			})
		case "/runner/media":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["index"] != float64(1) || body["chat"] != "fb-1" || body["message"] != "m-1" || body["app"] != "prhub" {
				http.Error(w, "no such media", http.StatusNotFound)
				return
			}
			_, _ = w.Write([]byte("mov"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "tok")
	item := WorkItem{Chat: "fb-1", Message: "m-1", App: "prhub", Login: "jai"}
	claimed, err := c.Claim(context.Background(), item)
	if err != nil || claimed == nil {
		t.Fatalf("claim: %+v err=%v", claimed, err)
	}
	if len(claimed.Images) != 1 || claimed.Images[0].MediaType != "image/jpeg" || claimed.Images[0].Data != "YQ==" {
		t.Fatalf("screenshots: %+v", claimed.Images)
	}
	if len(claimed.Videos) != 1 || claimed.Videos[0].Index != 1 || claimed.Videos[0].MediaType != "video/quicktime" ||
		claimed.Videos[0].DurationMs == nil || *claimed.Videos[0].DurationMs != 1500 {
		t.Fatalf("videos: %+v", claimed.Videos)
	}
	data, err := c.Media(context.Background(), item, 1)
	if err != nil || string(data) != "mov" {
		t.Fatalf("media: %q err=%v", data, err)
	}
	if _, err := c.Media(context.Background(), item, 9); err == nil {
		t.Fatalf("a video the Worker does not have is an error")
	}
}
