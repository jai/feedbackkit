package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jai/feedbackkit/rex-runner/internal/config"
	"github.com/jai/feedbackkit/rex-runner/internal/state"
)

// replyServer answers `/runner/agent` and keeps each side it was sent.
func replyServer(t *testing.T) (config.Config, *[]map[string]any) {
	t.Helper()
	posts := &[]map[string]any{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/runner/agent" {
			http.NotFound(w, r)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("agent side is not JSON: %v", err)
		}
		*posts = append(*posts, body)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)
	return config.Config{StateDir: t.TempDir(), WorkerURL: srv.URL, RunnerToken: "tok"}, posts
}

func TestReplyAskMarksAnOpenQuestionUntilTheNextReply(t *testing.T) {
	cfg, posts := replyServer(t)
	ctx := context.Background()
	asks := func(chat string) bool {
		t.Helper()
		rec, err := state.LoadChat(cfg.StateDir, chat)
		if err != nil {
			t.Fatal(err)
		}
		return rec.Asks
	}

	args := []string{"--chat", "fb_1", "--app", "prhub", "--login", "jai"}
	if err := cmdReply(ctx, cfg, append(args, "--text", "Which screen?", "--ask")); err != nil {
		t.Fatal(err)
	}
	if got := (*posts)[0]; got["asks"] != true || got["isWorking"] != false {
		t.Fatalf("a question: %v", got)
	}
	if !asks("fb_1") {
		t.Fatal("the chat record keeps the open question")
	}

	// A builder keeps working while its question is open.
	if err := cmdReply(ctx, cfg, []string{"--chat", "fb_1", "--text", "And which colour?", "--ask", "--working", "--activity", "Building"}); err != nil {
		t.Fatal(err)
	}
	if got := (*posts)[1]; got["asks"] != true || got["isWorking"] != true || got["activity"] != "Building" {
		t.Fatalf("a question while working: %v", got)
	}

	// The latest reply decides: one without --ask takes the question back.
	if err := cmdReply(ctx, cfg, []string{"--chat", "fb_1", "--text", "Never mind, done."}); err != nil {
		t.Fatal(err)
	}
	got := (*posts)[2]
	if _, sent := got["asks"]; sent {
		t.Fatalf("a reply without --ask sends no asks: %v", got)
	}
	if len(got["messages"].([]any)) != 3 {
		t.Fatalf("every message so far is resent: %v", got)
	}
	if asks("fb_1") {
		t.Fatal("the chat record no longer asks")
	}
}
