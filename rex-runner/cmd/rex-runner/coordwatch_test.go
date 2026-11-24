package main

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jai/feedbackkit/rex-runner/internal/config"
	"github.com/jai/feedbackkit/rex-runner/internal/rex"
)

func TestCoordinatorCommandUsesClaudeSwitchResumeWhenTranscriptExists(t *testing.T) {
	orig := resolveClaudeSwitchBin
	resolveClaudeSwitchBin = func(string) string { return "/opt/mise/claude-switch" }
	defer func() { resolveClaudeSwitchBin = orig }()

	cfg := config.Config{CoordLauncher: "cl1", CoordModel: "claude-fable-5-2"}
	got := coordinatorCommand(cfg, "939b1574-4e17-47f5-abd4-b667d7d6da06", "/state/prompts/coordinator.md", true)
	want := []string{
		"env", "REX_SESSION_NAMING=false",
		"/opt/mise/claude-switch", "resume", "939b1574-4e17-47f5-abd4-b667d7d6da06", "--next", "--",
		"--dangerously-skip-permissions", "--model", "claude-fable-5-2",
		"--append-system-prompt-file", "/state/prompts/coordinator.md", "--system-prompt-snapshot", "off",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestCoordinatorCommandUsesClaudeSwitchRunForNewSession(t *testing.T) {
	orig := resolveClaudeSwitchBin
	resolveClaudeSwitchBin = func(string) string { return "/opt/mise/claude-switch" }
	defer func() { resolveClaudeSwitchBin = orig }()

	cfg := config.Config{CoordLauncher: "cly", CoordModel: "claude-fable-5-2"}
	got := coordinatorCommand(cfg, "11111111-2222-4333-8444-555555555555", "/state/prompts/coordinator.md", false)
	want := []string{
		"env", "REX_SESSION_NAMING=false",
		"/opt/mise/claude-switch", "run", "--account", "cly", "--",
		"--dangerously-skip-permissions", "--model", "claude-fable-5-2",
		"--append-system-prompt-file", "/state/prompts/coordinator.md", "--system-prompt-snapshot", "off",
		"--session-id", "11111111-2222-4333-8444-555555555555",
		"--name", "feedback-coordinator",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestCoordinatorDownReason(t *testing.T) {
	cases := []struct {
		name   string
		screen string
		want   string
	}{
		{
			name: "live idle claude",
			screen: "✻ Baked for 8s · done 12:03 PM\n" +
				"─────── feedback-coordinator ─\n" +
				"❯ \n" +
				"  ⏵⏵ bypass permissions on (shift+tab to cycle)\n",
			want: "",
		},
		{
			name: "exited claude resume hint",
			screen: "Resume this session with:\n" +
				"claude --dangerously-skip-permissions --model claude-fable-5-2 --resume 939b1574\n",
			want: "exited",
		},
		{
			name: "rate limit prompt",
			screen: "You've hit your weekly limit · resets Nov 26 at 2am\n" +
				"❯ 1. Stop and wait for limit to reset\n",
			want: "rate_limit",
		},
		{
			name: "bare shell prompt after crash",
			screen: "feedback-coordinator %\n",
			want: "exited",
		},
		{
			name: "empty screen ignored",
			screen: "\n   \n",
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := coordinatorDownReason(tc.screen); got != tc.want {
				t.Fatalf("coordinatorDownReason() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCoordWatchdogRelaunchesExitedPaneAndHonorsCooldown(t *testing.T) {
	tmp := t.TempDir()
	coordDir := filepath.Join(tmp, "coord")
	if err := os.MkdirAll(coordDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(coordDir, ".session-id"), []byte("939b1574-4e17-47f5-abd4-b667d7d6da06\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	origResolve := resolveClaudeSwitchBin
	origTranscript := coordTranscriptExists
	origAlert := alertCoordinatorDown
	resolveClaudeSwitchBin = func(string) string { return "/opt/mise/claude-switch" }
	coordTranscriptExists = func(string, string) bool { return true }
	var alerts []string
	alertCoordinatorDown = func(msg string) { alerts = append(alerts, msg) }
	defer func() {
		resolveClaudeSwitchBin = origResolve
		coordTranscriptExists = origTranscript
		alertCoordinatorDown = origAlert
	}()

	var closed, created int
	var lastNewCmd []string
	winID, blkID := "win-old", "blk-old"
	windowPresent := true
	rc := &rex.Client{
		Bin: "rex",
		Exec: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
			joined := strings.Join(args, " ")
			switch {
			case joined == "ls --json":
				return []byte(`{"sessions":[{"session_id":"sess-1","label":"feedback-loop"}]}`), nil
			case strings.HasPrefix(joined, "window ls"):
				if windowPresent {
					return []byte(`{"windows":[{"window_id":"` + winID + `","label":"fable-coordinator","focused_block_id":"` + blkID + `"}]}`), nil
				}
				return []byte(`{"windows":[]}`), nil
			case strings.HasPrefix(joined, "capture "):
				return []byte("Resume this session with:\nclaude --resume 939b1574\n"), nil
			case strings.HasPrefix(joined, "window close"):
				closed++
				windowPresent = false
				return nil, nil
			case strings.HasPrefix(joined, "window new"):
				created++
				winID, blkID = "win-new", "blk-new"
				windowPresent = true
				lastNewCmd = append([]string(nil), args...)
				return []byte(`{"window_id":"win-new","block_id":"blk-new"}`), nil
			default:
				t.Fatalf("unexpected rex call: %v", args)
				return nil, nil
			}
		},
	}

	now := time.Date(2026, 11, 23, 22, 0, 0, 0, time.UTC)
	wd := newCoordWatchdog()
	wd.now = func() time.Time { return now }

	cfg := config.Config{
		SessionName:   "feedback-loop",
		CoordWindow:   "fable-coordinator",
		CoordDir:      coordDir,
		CoordLauncher: "cl1",
		CoordModel:    "claude-fable-5-2",
		StateDir:      tmp,
	}
	cur := rex.CreatedWindow{SessionID: "sess-1", WindowID: "win-old", BlockID: "blk-old"}
	next, changed, err := wd.check(context.Background(), cfg, rc, cur)
	if err != nil {
		t.Fatal(err)
	}
	if !changed || next.BlockID != "blk-new" || closed != 1 || created != 1 {
		t.Fatalf("expected relaunch: next=%+v changed=%v closed=%d created=%d", next, changed, closed, created)
	}
	joinedCmd := strings.Join(lastNewCmd, " ")
	if !strings.Contains(joinedCmd, "/opt/mise/claude-switch resume 939b1574-4e17-47f5-abd4-b667d7d6da06 --next") {
		t.Fatalf("expected claude-switch resume command, got: %s", joinedCmd)
	}

	// Second immediate failure inside 60s cooldown must NOT thrash-restart.
	windowPresent = true
	_, changed2, err := wd.check(context.Background(), cfg, rc, next)
	if err != nil {
		t.Fatal(err)
	}
	if changed2 || created != 1 || len(alerts) != 1 {
		t.Fatalf("expected cooldown block + alert: changed2=%v created=%d alerts=%v", changed2, created, alerts)
	}
}

func TestCoordWatchdogDismissesEscNotNowNagModal(t *testing.T) {
	tmp := t.TempDir()
	var sentKey string
	rc := &rex.Client{
		Bin: "rex",
		Exec: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
			joined := strings.Join(args, " ")
			switch {
			case joined == "ls --json":
				return []byte(`{"sessions":[{"session_id":"sess-1","label":"feedback-loop"}]}`), nil
			case strings.HasPrefix(joined, "window ls"):
				return []byte(`{"windows":[{"window_id":"win-1","label":"fable-coordinator","focused_block_id":"blk-1"}]}`), nil
			case strings.HasPrefix(joined, "capture "):
				return []byte("We recommend compacting earlier\n↑/↓ choose · enter confirm · esc not now\n"), nil
			case strings.HasPrefix(joined, "send-key "):
				sentKey = args[len(args)-1]
				return nil, nil
			default:
				t.Fatalf("unexpected rex call: %v", args)
				return nil, nil
			}
		},
	}
	wd := newCoordWatchdog()
	cfg := config.Config{SessionName: "feedback-loop", CoordWindow: "fable-coordinator", StateDir: tmp}
	cur := rex.CreatedWindow{SessionID: "sess-1", WindowID: "win-1", BlockID: "blk-1"}
	next, changed, err := wd.check(context.Background(), cfg, rc, cur)
	if err != nil {
		t.Fatal(err)
	}
	if changed || next != cur || sentKey != "escape" {
		t.Fatalf("expected escape dismiss without restart: next=%+v changed=%v sentKey=%q", next, changed, sentKey)
	}
}
