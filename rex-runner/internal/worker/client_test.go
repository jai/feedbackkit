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
}
