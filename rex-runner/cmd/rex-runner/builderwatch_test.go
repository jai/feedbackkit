package main

import (
	"strings"
	"testing"
	"time"

	"github.com/jai/feedbackkit/rex-runner/internal/state"
)

func TestStuckReason(t *testing.T) {
	old := transcriptExists
	defer func() { transcriptExists = old }()
	now := time.Now()
	m := state.RunManifest{Agent: "claude", SessionID: "s", CreatedAt: now.Add(-3 * time.Minute)}

	transcriptExists = func(string) bool { return true }
	trust := "Do you trust the files in this folder?\n ❯ 1. Yes, proceed\n   2. No, exit\n\n Enter to confirm · Esc to cancel\n"
	if got := stuckReason(m, trust, now); !strings.Contains(got, "prompt") {
		t.Fatalf("trust prompt: %q", got)
	}
	if got := stuckReason(m, "⏺ working\n❯ \n", now); got != "" {
		t.Fatalf("healthy pane: %q", got)
	}

	countdown := "⚠ Claude Code will automatically block this request in 1:41\nDo you want to proceed?\n❯ 1. Yes\n Esc to cancel · Tab to amend\n"
	if got := stuckReason(m, countdown, now); got != "" {
		t.Fatalf("self-clearing prompt: %q", got)
	}

	transcriptExists = func(string) bool { return false }
	if got := stuckReason(m, "$ \n", now); !strings.Contains(got, "no transcript") {
		t.Fatalf("no transcript: %q", got)
	}
	m.CreatedAt = now.Add(-30 * time.Second)
	if got := stuckReason(m, "$ \n", now); got != "" {
		t.Fatalf("young run: %q", got)
	}
	m.Agent, m.CreatedAt = "codex", now.Add(-time.Hour)
	if got := stuckReason(m, "$ \n", now); got != "" {
		t.Fatalf("codex has no transcript check: %q", got)
	}
}

func TestScreenTail(t *testing.T) {
	if got := screenTail("a\n\n b \nc\n", 2); got != "b | c" {
		t.Fatalf("got %q", got)
	}
}
