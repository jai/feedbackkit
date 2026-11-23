package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jai/feedbackkit/rex-runner/internal/config"
	"github.com/jai/feedbackkit/rex-runner/internal/inbox"
	"github.com/jai/feedbackkit/rex-runner/internal/rex"
	"github.com/jai/feedbackkit/rex-runner/internal/state"
)

// builderRules is appended to every new builder's prompt.
const builderRules = "\n\nStanding rules from rex-runner:\n" +
	"- Do not rename the Rex session you run in, and ignore any startup hint that tells you to name it. " +
	"The session is shared with the coordinator and the other builders; the runner finds the coordinator by its label."

// transcriptGrace is how long a Claude builder may run before it must have written a transcript.
const transcriptGrace = 2 * time.Minute

// transcriptExists reports whether a Claude session wrote its transcript under any ~/.claude* config dir.
// A variable so tests can stub it.
var transcriptExists = func(sessionID string) bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return true
	}
	hits, _ := filepath.Glob(filepath.Join(home, ".claude*", "projects", "*", sessionID+".jsonl"))
	return len(hits) > 0
}

// stuckReason says why an active builder is not working, from its screen and age; "" when it looks fine.
func stuckReason(m state.RunManifest, screen string, now time.Time) string {
	// A permission prompt with Claude Code's countdown blocks itself and the builder carries on: not stuck.
	selfClearing := strings.Contains(screen, "will automatically block this request")
	if marker := rex.DialogMarker(screen); marker != "" && !selfClearing {
		return fmt.Sprintf("the builder pane is waiting at a prompt (%q on screen)", marker)
	}
	if m.Agent == "claude" && m.SessionID != "" && !m.CreatedAt.IsZero() &&
		now.Sub(m.CreatedAt) > transcriptGrace && !transcriptExists(m.SessionID) {
		return fmt.Sprintf("the builder wrote no transcript in the %s since it started", transcriptGrace)
	}
	return ""
}

// screenTail is the last few non-empty lines of a pane, on one line, for an inbox event.
func screenTail(screen string, lines int) string {
	var tail []string
	all := strings.Split(screen, "\n")
	for i := len(all) - 1; i >= 0 && len(tail) < lines; i-- {
		if line := strings.TrimSpace(all[i]); line != "" {
			tail = append([]string{truncate(line, 120)}, tail...)
		}
	}
	return strings.Join(tail, " | ")
}

// checkBuilder reads one active builder's pane and files a builder_blocked event the first time it is stuck.
// The run stays active; the note is cleared once the pane looks fine, so a later stall is reported again.
func checkBuilder(ctx context.Context, cfg config.Config, rc *rex.Client, m state.RunManifest, now time.Time) (string, error) {
	if m.Status != state.StatusActive || m.RexSessionID == "" || m.RexBlockID == "" {
		return "", nil
	}
	screen, err := rc.Capture(ctx, m.RexSessionID, m.RexBlockID)
	if err != nil {
		return "", nil // pane gone: the reaper's business
	}
	reason := stuckReason(m, screen, now)
	if reason == m.StuckReason {
		return reason, nil
	}
	// Reload before saving: the builder may have reported while the pane was being read.
	fresh, err := state.Load(m.Dir)
	if err != nil || fresh.Status != state.StatusActive {
		return "", err
	}
	m = fresh
	m.StuckReason = reason
	if err := state.Save(m); err != nil {
		return reason, err
	}
	if reason == "" {
		return "", nil
	}
	_, err = inbox.New(cfg.StateDir).Append(inbox.Event{
		Kind:      "builder_blocked",
		ChatID:    m.ChatID,
		App:       m.App,
		Repo:      m.Repo,
		Status:    "stuck",
		Summary:   fmt.Sprintf("rex-runner check, not the builder: %s. It is marked active but is not working. Screen: %s", reason, screenTail(screen, 10)),
		RunDir:    m.Dir,
		RexWindow: m.RexWindowLabel,
	})
	return reason, err
}

// checkBuilders runs checkBuilder over every recorded run.
func checkBuilders(ctx context.Context, cfg config.Config, rc *rex.Client) {
	runs, err := state.ListAll(cfg.RunsDir)
	if err != nil {
		log.Printf("builder check: %v", err)
		return
	}
	for _, m := range runs {
		if reason, err := checkBuilder(ctx, cfg, rc, m, time.Now()); err != nil {
			log.Printf("builder check %s: %v", m.ChatID, err)
		} else if reason != "" {
			log.Printf("builder %s stuck: %s", m.ChatID, reason)
		}
	}
}
