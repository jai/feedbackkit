package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jai/feedbackkit/rex-runner/internal/config"
	"github.com/jai/feedbackkit/rex-runner/internal/rex"
)

const (
	coordRestartCooldown = 60 * time.Second
	coordRestartWindow   = 10 * time.Minute
	coordMaxRestarts     = 3
)

// resolveClaudeSwitchBin locates the Go `claude-switch` binary from jai/tools.
// Under launchd, mise shims may not be on PATH, so we check `~/.local/share/mise/shims/claude-switch` as a fallback.
var resolveClaudeSwitchBin = func(configured string) string {
	if s := strings.TrimSpace(configured); s != "" {
		return s
	}
	if p, err := exec.LookPath("claude-switch"); err == nil {
		return p
	}
	if home, err := os.UserHomeDir(); err == nil {
		shim := filepath.Join(home, ".local", "share", "mise", "shims", "claude-switch")
		if _, err := os.Stat(shim); err == nil {
			return shim
		}
	}
	return "claude-switch"
}

// ensureCoordSessionID reads the coordinator's pinned UUID from `<coordDir>/.session-id`,
// creating one if the file does not exist yet.
func ensureCoordSessionID(coordDir string) (string, error) {
	if err := os.MkdirAll(coordDir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(coordDir, ".session-id")
	if raw, err := os.ReadFile(path); err == nil {
		if id := strings.TrimSpace(string(raw)); id != "" {
			return id, nil
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	id := newUUIDv4()
	if err := os.WriteFile(path, []byte(id+"\n"), 0o600); err != nil {
		return "", err
	}
	return id, nil
}

// coordTranscriptExists reports whether the coordinator's pinned Claude transcript exists under ~/.claude.
var coordTranscriptExists = func(coordDir, sessionID string) bool {
	if sessionID == "" {
		return false
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	encoded := strings.ReplaceAll(coordDir, "/", "-")
	direct := filepath.Join(home, ".claude", "projects", encoded, sessionID+".jsonl")
	if _, err := os.Stat(direct); err == nil {
		return true
	}
	return transcriptExists(sessionID)
}

// resolveAgyBin locates the Antigravity CLI (`agy`), checking Homebrew's bin path as a launchd fallback.
var resolveAgyBin = func() string {
	if p, err := exec.LookPath("agy"); err == nil {
		return p
	}
	if _, err := os.Stat("/opt/homebrew/bin/agy"); err == nil {
		return "/opt/homebrew/bin/agy"
	}
	return "agy"
}

// agyCoordStarted reports whether an Antigravity coordinator session has already run in coordDir.
var agyCoordStarted = func(coordDir string) bool {
	if coordDir == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(coordDir, ".agy-started"))
	return err == nil
}

// coordinatorCommand builds the command that launches or resumes the feedback coordinator inside Rex
// without any wrapper shell script. Supports both Claude (`claude-switch`) and Antigravity (`agy`).
func coordinatorCommand(cfg config.Config, sessionID string, hasTranscript bool) []string {
	if strings.EqualFold(strings.TrimSpace(cfg.CoordAgent), "agy") {
		model := strings.TrimSpace(cfg.CoordModel)
		if model == "" || strings.HasPrefix(model, "claude-fable") {
			model = config.DefaultAgyCoordModel
		}
		args := []string{
			"env", "REX_SESSION_NAMING=false",
			resolveAgyBin(), "--dangerously-skip-permissions", "--model", model,
		}
		if hasTranscript {
			args = append(args, "--continue")
		}
		return args
	}
	bin := resolveClaudeSwitchBin(cfg.ClaudeSwitchBin)
	model := strings.TrimSpace(cfg.CoordModel)
	if model == "" {
		model = config.DefaultCoordModel
	}
	launcher := strings.TrimSpace(cfg.CoordLauncher)
	if launcher == "" {
		launcher = config.DefaultCoordLauncher
	}
	if hasTranscript && sessionID != "" {
		return []string{
			"env", "REX_SESSION_NAMING=false",
			bin, "resume", sessionID, "--next", "--",
			"--dangerously-skip-permissions", "--model", model,
		}
	}
	args := []string{
		"env", "REX_SESSION_NAMING=false",
		bin, "run", "--account", launcher, "--",
		"--dangerously-skip-permissions", "--model", model,
	}
	if sessionID != "" {
		args = append(args, "--session-id", sessionID)
	}
	args = append(args, "--name", "feedback-coordinator")
	return args
}

// rateLimitMarkers are unambiguous bottom-of-screen Claude usage-limit banners.
var rateLimitMarkers = []string{
	"you've hit your limit",
	"you've hit your weekly limit",
	"hit your weekly limit",
	"out of extra usage",
	"stop and wait for limit to reset",
}

// exitedMarkers are unambiguous bottom-of-screen lines showing Claude exited back to Rex/shell.
var exitedMarkers = []string{
	"resume this session with:",
	"[process exited",
	"process exited with status",
	"command not found",
}

// claudeAliveMarkers indicate Claude Code or Antigravity live TUI chrome is still drawn at the bottom of the pane.
var claudeAliveMarkers = []string{
	"bypass permissions",
	"shift+tab to cycle",
	"esc to interrupt",
	"ctrl+o to expand",
	"auto ·",
	"gemini 4",
	"gemini 3",
	"claude opus",
	"claude sonnet",
	"tip: use /",
	"esc to cancel",
}

// coordinatorDownReason inspects the bottom of the coordinator's Rex pane and returns
// "rate_limit", "exited", or "" when Claude looks alive. Conservative by design so a busy
// or idle live coordinator is never killed.
func coordinatorDownReason(screen string) string {
	var tail []string
	lines := strings.Split(screen, "\n")
	for i := len(lines) - 1; i >= 0 && len(tail) < 12; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			tail = append(tail, strings.ToLower(line))
		}
	}
	if len(tail) == 0 {
		return ""
	}
	for _, line := range tail {
		for _, m := range rateLimitMarkers {
			if strings.Contains(line, m) {
				return "rate_limit"
			}
		}
	}
	// Check exited markers on the last 5 non-empty lines only (older scrollback could quote them).
	lastFive := tail
	if len(lastFive) > 5 {
		lastFive = lastFive[:5]
	}
	for _, line := range lastFive {
		for _, m := range exitedMarkers {
			if strings.Contains(line, m) {
				return "exited"
			}
		}
	}
	// Bare shell prompt at the very bottom with zero Claude TUI chrome in the last 6 lines.
	lastLine := tail[0]
	hasChrome := false
	checkChrome := tail
	if len(checkChrome) > 6 {
		checkChrome = checkChrome[:6]
	}
	for _, line := range checkChrome {
		for _, c := range claudeAliveMarkers {
			if strings.Contains(line, c) {
				hasChrome = true
				break
			}
		}
	}
	if !hasChrome && (strings.HasSuffix(lastLine, "%") || strings.HasSuffix(lastLine, "$") ||
		strings.Contains(lastLine, "@borg-cube-") || strings.Contains(lastLine, "zsh: ")) {
		return "exited"
	}
	return ""
}

// scanLimitForAccount asks `claude-switch limits --scan-session` to record a limit before failover.
var scanLimitForAccount = func(ctx context.Context, cfg config.Config, sessionID string) {
	if sessionID == "" {
		return
	}
	bin := resolveClaudeSwitchBin(cfg.ClaudeSwitchBin)
	acct := strings.TrimSpace(cfg.CoordLauncher)
	if acct == "" {
		acct = config.DefaultCoordLauncher
	}
	cmd := exec.CommandContext(ctx, bin, "limits", "--scan-session", sessionID, "--account", acct)
	_ = cmd.Run()
}

var (
	coordAlertMu sync.Mutex
	coordAlertAt time.Time
)

var alertCoordinatorDown = func(reason string) {
	coordAlertMu.Lock()
	defer coordAlertMu.Unlock()
	if time.Since(coordAlertAt) < 10*time.Minute {
		return
	}
	coordAlertAt = time.Now()
	msg := fmt.Sprintf("Feedback coordinator watchdog needs attention: %s", reason)
	log.Printf("ALERT: %s", msg)
	var cmd *exec.Cmd
	if custom := strings.TrimSpace(os.Getenv("FEEDBACK_ALERT_CMD")); custom != "" {
		cmd = exec.Command(custom, msg)
	} else {
		cmd = exec.Command("osascript", "-e", "on run argv\ndisplay notification (item 1 of argv) with title \"FeedbackKit\"\nend run", msg)
	}
	if err := cmd.Run(); err != nil {
		log.Printf("coordinator alert failed: %v", err)
	}
}

// coordWatchdog supervises the feedback coordinator pane inside `rex-runner serve`.
// It enforces restart cooldown + sliding-window caps so a broken account never thrash-loops.
type coordWatchdog struct {
	mu           sync.Mutex
	restarts     []time.Time
	lastRestart  time.Time
	now          func() time.Time
	cooldown     time.Duration
	window       time.Duration
	maxInWindow  int
}

func newCoordWatchdog() *coordWatchdog {
	return &coordWatchdog{
		now:         time.Now,
		cooldown:    coordRestartCooldown,
		window:      coordRestartWindow,
		maxInWindow: coordMaxRestarts,
	}
}

func (w *coordWatchdog) allowRestart() (bool, string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	now := w.now()
	if !w.lastRestart.IsZero() && now.Sub(w.lastRestart) < w.cooldown {
		return false, fmt.Sprintf("restart cooldown active (%s remaining)", (w.cooldown - now.Sub(w.lastRestart)).Round(time.Second))
	}
	kept := w.restarts[:0]
	for _, t := range w.restarts {
		if now.Sub(t) < w.window {
			kept = append(kept, t)
		}
	}
	w.restarts = kept
	if len(w.restarts) >= w.maxInWindow {
		return false, fmt.Sprintf("coordinator restarted %d times in %s; pausing auto-restart", len(w.restarts), w.window)
	}
	w.lastRestart = now
	w.restarts = append(w.restarts, now)
	return true, ""
}

// check verifies that the coordinator window exists and Claude is healthy inside it.
// Returns (updatedCoord, changed, err). When changed is true, callers should rebind OSC 7501 streaming.
func (w *coordWatchdog) check(ctx context.Context, cfg config.Config, rc *rex.Client, current rex.CreatedWindow) (rex.CreatedWindow, bool, error) {
	sess, err := findCoordSession(ctx, cfg, rc)
	if err != nil {
		return current, false, err
	}
	var liveWin *rex.Window
	if sess != nil {
		wins, err := rc.ListWindows(ctx, sess.SessionID)
		if err != nil {
			return current, false, err
		}
		for i := range wins {
			if wins[i].Label == cfg.CoordWindow {
				liveWin = &wins[i]
				break
			}
		}
	}

	// Case 1: session or coordinator tab vanished.
	if sess == nil || liveWin == nil {
		ok, why := w.allowRestart()
		if !ok {
			alertCoordinatorDown(why)
			return current, false, nil
		}
		log.Printf("coordinator watchdog: tab missing; recreating via claude-switch")
		recreated, err := ensureCoordinator(ctx, cfg, rc)
		if err != nil {
			alertCoordinatorDown("recreate failed: " + err.Error())
			return current, false, err
		}
		return recreated, true, nil
	}

	// Keep current target synced if another actor already recreated the tab.
	updated := rex.CreatedWindow{
		SessionID: sess.SessionID,
		WindowID:  liveWin.WindowID,
		BlockID:   liveWin.FocusedBlockID,
	}
	rebound := updated.SessionID != current.SessionID || updated.BlockID != current.BlockID

	screen, err := rc.Capture(ctx, updated.SessionID, updated.BlockID)
	if err != nil {
		return updated, rebound, err
	}
	// Auto-dismiss non-destructive Claude Code nag modals (e.g. "We recommend compacting earlier · esc not now")
	// so the coordinator never stalls overnight waiting for Escape.
	if rex.DialogMarker(screen) == "esc not now" {
		log.Printf("coordinator watchdog: dismissing %q modal via Escape in %s", "esc not now", updated.BlockID)
		if err := rc.SendKey(ctx, updated.SessionID, updated.BlockID, "escape"); err != nil {
			log.Printf("coordinator watchdog: send escape failed: %v", err)
		}
		return updated, rebound, nil
	}
	reason := coordinatorDownReason(screen)
	if reason == "" {
		return updated, rebound, nil
	}

	ok, why := w.allowRestart()
	if !ok {
		alertCoordinatorDown(fmt.Sprintf("%s (%s)", reason, why))
		return updated, rebound, nil
	}
	log.Printf("coordinator watchdog: detected %s in %s; relaunching (%s)", reason, updated.BlockID, cfg.CoordAgent)
	if reason == "rate_limit" && !strings.EqualFold(strings.TrimSpace(cfg.CoordAgent), "agy") {
		if sid, err := ensureCoordSessionID(cfg.CoordDir); err == nil {
			scanLimitForAccount(ctx, cfg, sid)
		}
	}
	if err := rc.CloseWindow(ctx, updated.SessionID, updated.WindowID); err != nil {
		log.Printf("coordinator watchdog: close old window %s failed: %v", updated.WindowID, err)
	}
	recreated, err := ensureCoordinator(ctx, cfg, rc)
	if err != nil {
		alertCoordinatorDown("relaunch failed: " + err.Error())
		return updated, rebound, err
	}
	log.Printf("coordinator watchdog: relaunched coordinator session=%s window=%s block=%s", recreated.SessionID, recreated.WindowID, recreated.BlockID)
	return recreated, true, nil
}
