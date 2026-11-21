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
					{"chat": "fb-1", "message": "m-1", "app": "prhub", "login": "jai", "repo": "jai/prhub", "role": "owner"},
				},
			})
		case "/runner/claim":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"chat": "fb-1", "app": "prhub", "login": "jai", "repo": "jai/prhub", "role": "owner", "text": "Fix font",
			})
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
	if err != nil || len(work) != 1 || work[0].Chat != "fb-1" {
		t.Fatalf("poll: %+v err=%v", work, err)
	}
	claimed, err := c.Claim(context.Background(), work[0])
	if err != nil || claimed == nil || claimed.Text != "Fix font" {
		t.Fatalf("claim: %+v err=%v", claimed, err)
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
