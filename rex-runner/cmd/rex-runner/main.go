package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jai/feedbackkit/rex-runner/internal/config"
	"github.com/jai/feedbackkit/rex-runner/internal/inbox"
	"github.com/jai/feedbackkit/rex-runner/internal/reaper"
	"github.com/jai/feedbackkit/rex-runner/internal/rex"
	"github.com/jai/feedbackkit/rex-runner/internal/state"
	"github.com/jai/feedbackkit/rex-runner/internal/worker"
)

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cfg := config.Default()
	cfg.CoordLauncher = config.LoadRuntimeCoordLauncher(cfg.StateDir, cfg.CoordLauncher)
	_ = cfg.LoadCredentials()
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	var err error
	switch os.Args[1] {
	case "status":
		err = cmdStatus(ctx, cfg, os.Args[2:])
	case "push-status":
		err = cmdPushStatus(ctx, cfg, os.Args[2:])
	case "boot":
		err = cmdBoot(ctx, cfg, os.Args[2:])
	case "spawn":
		err = cmdSpawn(ctx, cfg, os.Args[2:])
	case "report":
		err = cmdReport(cfg, os.Args[2:])
	case "reply":
		err = cmdReply(ctx, cfg, os.Args[2:])
	case "drain":
		err = cmdDrain(ctx, cfg, os.Args[2:])
	case "reap":
		err = cmdReap(ctx, cfg, os.Args[2:])
	case "serve":
		err = cmdServe(ctx, cfg, os.Args[2:])
	case "-h", "--help", "help":
		usage()
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "rex-runner %s: %v\n", os.Args[1], err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `rex-runner — nondestructive Go runner for the Rex Feedback Loop

Usage:
  rex-runner <command> [flags]

Commands:
  status       Show Rex session, Fable coordinator, inbox depth, and builder runs
  push-status  Publish sanitized Rex status snapshot to Worker (/about live dashboard)
  boot         Ensure feedback-loop session, Fable Tab 1, and resume unfinished runs
  spawn    Create an isolated run folder + run.json, open a Rex tab, enqueue inbox
  report       Record builder progress/completion and append to Fable's FIFO inbox
  reply        Post a user-facing reply/status back to the FeedbackKit Worker (phone/app)
  drain        Deliver queued inbox.jsonl events to Fable's Rex block and ack cursor
  reap     Deterministically close/prune clean, pushed runs idle past TTL
  serve    Run the long-lived wake-up loop (boot + OSC 7501 drain + reap + optional opt-in Worker poll)
`)
}

type statusSnapshot struct {
	SessionName    string              `json:"session_name"`
	SessionID      string              `json:"session_id,omitempty"`
	CoordWindowID  string              `json:"coord_window_id,omitempty"`
	CoordBlockID   string              `json:"coord_block_id,omitempty"`
	InboxPending   int                 `json:"inbox_pending"`
	Runs           []state.RunManifest `json:"runs"`
	ClaimApps      []string            `json:"claim_apps"`
	GeneratedAtUTC time.Time           `json:"generated_at_utc"`
}

func buildStatus(ctx context.Context, cfg config.Config, rc *rex.Client) (statusSnapshot, error) {
	snap := statusSnapshot{
		SessionName:    cfg.SessionName,
		Runs:           []state.RunManifest{},
		ClaimApps:      []string{},
		GeneratedAtUTC: time.Now().UTC(),
	}
	if sess, err := findCoordSession(ctx, cfg, rc); err == nil && sess != nil {
		snap.SessionID = sess.SessionID
		if wins, err := rc.ListWindows(ctx, sess.SessionID); err == nil {
			for _, w := range wins {
				if w.Label == cfg.CoordWindow {
					snap.CoordWindowID = w.WindowID
					snap.CoordBlockID = w.FocusedBlockID
					break
				}
			}
		}
	}
	if pending, _, err := inbox.New(cfg.StateDir).Pending(); err == nil {
		snap.InboxPending = len(pending)
	}
	if runs, err := state.ListAll(cfg.RunsDir); err == nil && len(runs) > 0 {
		snap.Runs = runs
	}
	for app := range cfg.ClaimApps {
		snap.ClaimApps = append(snap.ClaimApps, app)
	}
	return snap, nil
}

func pushLiveStatus(ctx context.Context, cfg config.Config, rc *rex.Client, coordState string, daemon bool) error {
	if cfg.WorkerURL == "" || cfg.RunnerToken == "" {
		return errors.New("FEEDBACKKIT_URL and FEEDBACKKIT_RUNNER_TOKEN are required")
	}
	snap, err := buildStatus(ctx, cfg, rc)
	if err != nil {
		return err
	}
	runs := make([]worker.RexRunSummary, 0, len(snap.Runs))
	for _, r := range snap.Runs {
		runs = append(runs, worker.RexRunSummary{
			ChatID:      r.ChatID,
			App:         r.App,
			Agent:       r.Agent,
			Status:      string(r.Status),
			UpdatedAtMs: r.UpdatedAt.UnixMilli(),
		})
	}
	if coordState == "" {
		coordState = "idle"
	}
	wc := worker.NewClient(cfg.WorkerURL, cfg.RunnerToken)
	if err := wc.PushRexStatus(ctx, worker.RexStatusPayload{
		SessionName:       snap.SessionName,
		SessionActive:     snap.SessionID != "",
		CoordinatorActive: snap.CoordBlockID != "",
		CoordinatorState:  coordState,
		InboxPending:      snap.InboxPending,
		DaemonRunning:     daemon,
		ClaimApps:         snap.ClaimApps,
		Runs:              runs,
	}); err != nil {
		return err
	}

	// Capture live Rex panes & recent inbox for authenticated `/about/inspect` drill-down.
	var panes []worker.RexInspectPane
	if snap.SessionID != "" && snap.CoordBlockID != "" {
		if capText, err := rc.Capture(ctx, snap.SessionID, snap.CoordBlockID); err == nil {
			panes = append(panes, worker.RexInspectPane{
				ID:      cfg.CoordWindow,
				Label:   "Fable 5.2 Coordinator",
				Kind:    "coordinator",
				Status:  coordState,
				Agent:   "claude-fable-5-2",
				Capture: capText,
			})
		}
	}
	for _, r := range snap.Runs {
		if r.Status == state.StatusReaped || r.RexSessionID == "" || r.RexBlockID == "" {
			continue
		}
		if capText, err := rc.Capture(ctx, r.RexSessionID, r.RexBlockID); err == nil {
			panes = append(panes, worker.RexInspectPane{
				ID:      r.ChatID,
				Label:   r.ChatID + " (" + r.App + ")",
				Kind:    "builder",
				Status:  string(r.Status),
				Agent:   r.Agent,
				App:     r.App,
				Capture: capText,
			})
		}
	}
	var recentInbox []worker.RexInspectInboxEvent
	if evs, err := inbox.New(cfg.StateDir).Recent(20); err == nil {
		for _, ev := range evs {
			recentInbox = append(recentInbox, worker.RexInspectInboxEvent{
				ID:        ev.ID,
				Kind:      ev.Kind,
				ChatID:    ev.ChatID,
				App:       ev.App,
				Status:    ev.Status,
				Summary:   ev.Summary,
				CreatedAt: ev.CreatedAt.UTC().Format(time.RFC3339),
			})
		}
	}
	_ = wc.PushRexInspect(ctx, worker.RexInspectPayload{
		SessionName: snap.SessionName,
		Panes:       panes,
		RecentInbox: recentInbox,
	})
	return nil
}

func cmdPushStatus(ctx context.Context, cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("push-status", flag.ExitOnError)
	coordState := fs.String("coord-state", "idle", "current coordinator OSC 7501 state")
	daemon := fs.Bool("daemon", false, "mark daemon_running=true")
	_ = fs.Parse(args)

	cfg.ClaimApps = config.LoadRuntimeClaimApps(cfg.StateDir, cfg.ClaimApps)
	if err := pushLiveStatus(ctx, cfg, rex.NewClient(cfg.RexBinary), *coordState, *daemon); err != nil {
		return err
	}
	fmt.Printf("pushed Rex status + live inspect snapshot to %s\n", strings.TrimRight(cfg.WorkerURL, "/"))
	return nil
}

func cmdReply(ctx context.Context, cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("reply", flag.ExitOnError)
	chatID := fs.String("chat", "", "FeedbackKit chat ID (e.g. fb_...)")
	text := fs.String("text", "", "reply text to show on Jai's phone/app")
	app := fs.String("app", "", "app slug (auto-resolved from chat record if omitted)")
	login := fs.String("login", "", "sender GitHub login (auto-resolved from chat record if omitted)")
	working := fs.Bool("working", false, "whether the agent is still actively working")
	activity := fs.String("activity", "", "optional short working status line (<=80 chars)")
	var ships shipFlags
	fs.Var(&ships, "ship", "what the chat shipped: owner/repo@sha[@release-tag]; repeatable. Sets the chat's status to On main / Released; kept for later replies")
	_ = fs.Parse(args)

	if *chatID == "" {
		return errors.New("--chat is required")
	}
	if cfg.WorkerURL == "" || cfg.RunnerToken == "" {
		return errors.New("FEEDBACKKIT_URL and FEEDBACKKIT_RUNNER_TOKEN are required")
	}
	rec, err := state.LoadChat(cfg.StateDir, *chatID)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		rec = state.ChatRecord{ChatID: *chatID}
	}
	if *app != "" {
		rec.App = *app
	}
	if *login != "" {
		rec.Login = *login
	}
	if rec.App == "" || rec.Login == "" {
		return errors.New("chat app/login unknown; pass --app and --login")
	}
	if strings.TrimSpace(*text) != "" {
		now := time.Now().UTC()
		rec.Messages = append(rec.Messages, state.ChatReply{
			ID:   fmt.Sprintf("rex-%d", now.UnixNano()),
			Text: strings.TrimSpace(*text),
			At:   now.Format(time.RFC3339),
		})
	}
	if len(ships) > 0 {
		landed, err := resolveShipped(ships)
		if err != nil {
			return err
		}
		rec.Shipped = landed
	}
	if err := state.SaveChat(cfg.StateDir, rec); err != nil {
		return err
	}
	msgs := make([]worker.AgentMessage, 0, len(rec.Messages))
	for _, m := range rec.Messages {
		msgs = append(msgs, worker.AgentMessage{ID: m.ID, Text: m.Text, At: m.At})
	}
	var act *string
	if strings.TrimSpace(*activity) != "" {
		s := truncate(*activity, 80)
		act = &s
	}
	if err := worker.NewClient(cfg.WorkerURL, cfg.RunnerToken).PostAgent(ctx, worker.AgentSidePayload{
		App:       rec.App,
		Login:     rec.Login,
		Chat:      rec.ChatID,
		Messages:  msgs,
		IsWorking: *working,
		Activity:  act,
		Thread:    nil,
		Shipped:   rec.Shipped,
	}); err != nil {
		return err
	}
	fmt.Printf("replied to %s (%s/%s): %d message(s) working=%v\n", rec.ChatID, rec.App, rec.Login, len(msgs), *working)
	return nil
}

func cmdStatus(ctx context.Context, cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "output JSON snapshot")
	_ = fs.Parse(args)

	snap, err := buildStatus(ctx, cfg, rex.NewClient(cfg.RexBinary))
	if err != nil {
		return err
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(snap)
	}
	fmt.Printf("session:     %s (%s)\n", snap.SessionName, orNone(snap.SessionID))
	fmt.Printf("coordinator: %s (window=%s block=%s)\n", cfg.CoordWindow, orNone(snap.CoordWindowID), orNone(snap.CoordBlockID))
	fmt.Printf("inbox:       %d pending event(s)\n", snap.InboxPending)
	fmt.Printf("runs:        %d recorded in %s\n", len(snap.Runs), cfg.RunsDir)
	for _, r := range snap.Runs {
		fmt.Printf("  - %-14s [%s] agent=%-6s repo=%s tab=%s\n", r.ChatID, r.Status, r.Agent, r.Repo, orNone(r.RexWindowLabel))
	}
	return nil
}

func ensureCoordinator(ctx context.Context, cfg config.Config, rc *rex.Client) (rex.CreatedWindow, error) {
	startScript := filepath.Join(cfg.CoordDir, "start.sh")
	coordCmd := []string{startScript, cfg.CoordLauncher}

	sess, err := findCoordSession(ctx, cfg, rc)
	if err != nil {
		return rex.CreatedWindow{}, err
	}
	if sess == nil {
		return rc.NewSession(ctx, cfg.SessionName, cfg.CoordWindow, cfg.CoordDir, coordCmd)
	}
	wins, err := rc.ListWindows(ctx, sess.SessionID)
	if err != nil {
		return rex.CreatedWindow{}, err
	}
	for _, w := range wins {
		if w.Label == cfg.CoordWindow {
			return rex.CreatedWindow{
				SessionID: sess.SessionID,
				WindowID:  w.WindowID,
				BlockID:   w.FocusedBlockID,
			}, nil
		}
	}
	return rc.NewWindow(ctx, sess.SessionID, cfg.CoordWindow, cfg.CoordDir, false, coordCmd)
}

// findCoordSession finds the coordinator's Rex session by label and remembers its ID. Agents in the session
// rename it (Rex asks every agent to name its session); when the label is gone but the remembered session is
// still there, it is renamed back and used, so a rename never starts a second coordinator.
func findCoordSession(ctx context.Context, cfg config.Config, rc *rex.Client) (*rex.Session, error) {
	sessions, err := rc.ListSessions(ctx)
	if err != nil {
		return nil, err
	}
	saved := filepath.Join(cfg.StateDir, "coordinator-session")
	for i := range sessions {
		if sessions[i].Label == cfg.SessionName {
			if raw, _ := os.ReadFile(saved); strings.TrimSpace(string(raw)) != sessions[i].SessionID {
				_ = os.WriteFile(saved, []byte(sessions[i].SessionID+"\n"), 0o600)
			}
			return &sessions[i], nil
		}
	}
	raw, _ := os.ReadFile(saved)
	id := strings.TrimSpace(string(raw))
	if id == "" {
		return nil, nil
	}
	for i := range sessions {
		if sessions[i].SessionID == id {
			log.Printf("coordinator session %s was renamed to %q; renaming back to %q", id, sessions[i].Label, cfg.SessionName)
			if err := rc.RenameSession(ctx, id, cfg.SessionName); err != nil {
				log.Printf("rename back failed: %v", err)
			}
			sessions[i].Label = cfg.SessionName
			return &sessions[i], nil
		}
	}
	return nil, nil
}

// builderCommand is the builder's command line. A Claude builder with a configDir runs under
// `env CLAUDE_CONFIG_DIR=<configDir>`, which picks its Claude account.
func builderCommand(agent, model, sessionID, prompt, configDir string, resume bool) ([]string, error) {
	switch agent {
	case "claude":
		args := []string{"claude", "--dangerously-skip-permissions"}
		if configDir != "" {
			args = append([]string{"env", "CLAUDE_CONFIG_DIR=" + configDir}, args...)
		}
		if model != "" {
			args = append(args, "--model", model)
		}
		if resume && sessionID != "" {
			args = append(args, "--resume", sessionID)
		} else if sessionID != "" {
			args = append(args, "--session-id", sessionID)
		}
		if !resume && prompt != "" {
			args = append(args, prompt)
		}
		return args, nil
	case "codex":
		if resume && sessionID != "" {
			return []string{"codex", "resume", sessionID}, nil
		}
		args := []string{"codex", "--yolo"}
		if model != "" {
			args = append(args, "--model", model)
		}
		if prompt != "" {
			args = append(args, prompt)
		}
		return args, nil
	case "agy":
		args := []string{"agy"}
		if resume && sessionID != "" {
			args = append(args, "--resume", sessionID)
		} else if prompt != "" {
			args = append(args, prompt)
		}
		return args, nil
	default:
		return nil, fmt.Errorf("unsupported agent %q (expected claude, codex, or agy)", agent)
	}
}

func cmdBoot(ctx context.Context, cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("boot", flag.ExitOnError)
	dryRun := fs.Bool("dry-run", false, "report what boot would start without opening Rex windows")
	_ = fs.Parse(args)

	rc := rex.NewClient(cfg.RexBinary)
	if *dryRun {
		snap, err := buildStatus(ctx, cfg, rc)
		if err != nil {
			return err
		}
		fmt.Printf("[dry-run] session=%s coord_block=%s runs=%d\n", orNone(snap.SessionID), orNone(snap.CoordBlockID), len(snap.Runs))
		return nil
	}

	coord, err := ensureCoordinator(ctx, cfg, rc)
	if err != nil {
		return err
	}
	fmt.Printf("coordinator ready: session=%s window=%s block=%s\n", coord.SessionID, coord.WindowID, coord.BlockID)

	wins, err := rc.ListWindows(ctx, coord.SessionID)
	if err != nil {
		return err
	}
	liveByID := map[string]bool{}
	liveByLabel := map[string]bool{}
	for _, w := range wins {
		liveByID[w.WindowID] = true
		liveByLabel[w.Label] = true
	}

	runs, err := state.ListAll(cfg.RunsDir)
	if err != nil {
		return err
	}
	resumed := 0
	for _, m := range runs {
		if m.IsTerminal() {
			continue
		}
		if liveByID[m.RexWindowID] || (m.RexWindowLabel != "" && liveByLabel[m.RexWindowLabel]) {
			continue
		}
		cmdArgs, err := builderCommand(m.Agent, m.Model, m.SessionID, "", config.LoadRuntimeBuilderConfigDir(cfg.StateDir, cfg.BuilderConfigDir), true)
		if err != nil {
			log.Printf("skip resume %s: %v", m.ChatID, err)
			continue
		}
		label := m.RexWindowLabel
		if label == "" {
			label = m.ChatID
		}
		created, err := rc.NewWindow(ctx, coord.SessionID, label, m.Dir, false, cmdArgs)
		if err != nil {
			log.Printf("resume %s failed: %v", m.ChatID, err)
			continue
		}
		m.RexSessionID = coord.SessionID
		m.RexWindowID = created.WindowID
		m.RexWindowLabel = label
		m.RexBlockID = created.BlockID
		_ = state.Save(m)
		resumed++
		fmt.Printf("resumed %s in window=%s (%s)\n", m.ChatID, created.WindowID, m.Agent)
	}
	fmt.Printf("boot complete (%d builder run(s) resumed)\n", resumed)
	return nil
}

func cmdSpawn(ctx context.Context, cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("spawn", flag.ExitOnError)
	chatID := fs.String("chat", "", "feedback chat ID (e.g. fb-1a2b3c4d)")
	app := fs.String("app", "", "app slug (e.g. agent-pager, prhub)")
	repo := fs.String("repo", "", "target repository (owner/name)")
	branch := fs.String("branch", "", "git branch name (defaults to chat ID)")
	agent := fs.String("agent", "claude", "builder agent: claude | codex | agy")
	model := fs.String("model", "", "optional model override")
	dir := fs.String("dir", "", "working directory (defaults to <runs-dir>/<chat>)")
	prompt := fs.String("prompt", "", "initial task prompt for builder")
	dryRun := fs.Bool("dry-run", false, "write no Rex tabs; print planned spawn")
	_ = fs.Parse(args)

	if *chatID == "" || *app == "" || *repo == "" {
		return errors.New("--chat, --app, and --repo are required")
	}
	runDir := *dir
	if runDir == "" {
		runDir = filepath.Join(cfg.RunsDir, *chatID)
	}
	sessionID := newUUIDv4()
	if strings.TrimSpace(*prompt) != "" {
		*prompt += builderRules
	}
	cmdArgs, err := builderCommand(*agent, *model, sessionID, *prompt, config.LoadRuntimeBuilderConfigDir(cfg.StateDir, cfg.BuilderConfigDir), false)
	if err != nil {
		return err
	}
	if *dryRun {
		fmt.Printf("[dry-run] spawn chat=%s dir=%s cmd=%q\n", *chatID, runDir, strings.Join(cmdArgs, " "))
		return nil
	}
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		return err
	}
	rc := rex.NewClient(cfg.RexBinary)
	coord, err := ensureCoordinator(ctx, cfg, rc)
	if err != nil {
		return err
	}
	created, err := rc.NewWindow(ctx, coord.SessionID, *chatID, runDir, false, cmdArgs)
	if err != nil {
		return err
	}
	br := *branch
	if br == "" {
		br = *chatID
	}
	m := state.RunManifest{
		Version:        1,
		ChatID:         *chatID,
		App:            *app,
		Repo:           *repo,
		Branch:         br,
		Dir:            runDir,
		Agent:          *agent,
		Model:          *model,
		SessionID:      sessionID,
		RexSessionID:   coord.SessionID,
		RexWindowID:    created.WindowID,
		RexWindowLabel: *chatID,
		RexBlockID:     created.BlockID,
		Status:         state.StatusActive,
	}
	if err := state.Save(m); err != nil {
		return err
	}
	_, err = inbox.New(cfg.StateDir).Append(inbox.Event{
		Kind:      "spawned",
		ChatID:    m.ChatID,
		App:       m.App,
		Repo:      m.Repo,
		Status:    string(m.Status),
		Summary:   fmt.Sprintf("Builder tab opened (%s). Prompt: %s", m.Agent, truncate(*prompt, 160)),
		RunDir:    m.Dir,
		RexWindow: m.RexWindowLabel,
	})
	if err != nil {
		return err
	}
	fmt.Printf("spawned %s: window=%s block=%s dir=%s\n", m.ChatID, created.WindowID, created.BlockID, m.Dir)
	// Look at the new pane once it has drawn: a builder waiting at a prompt (folder trust, login) never starts.
	select {
	case <-ctx.Done():
		return nil
	case <-time.After(8 * time.Second):
	}
	if saved, err := state.Load(m.Dir); err == nil {
		if reason, _ := checkBuilder(ctx, cfg, rc, saved, time.Now()); reason != "" {
			fmt.Printf("WARNING: %s is not working: %s\n", m.ChatID, reason)
		}
	}
	return nil
}

func cmdReport(cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("report", flag.ExitOnError)
	chatID := fs.String("chat", "", "feedback chat ID")
	statusStr := fs.String("status", "done", "status: active | blocked | done | failed")
	summary := fs.String("summary", "", "concise update for Fable coordinator")
	pr := fs.String("pr", "", "optional PR URL or commit reference")
	_ = fs.Parse(args)

	if *chatID == "" || strings.TrimSpace(*summary) == "" {
		return errors.New("--chat and --summary are required")
	}
	m, err := state.FindByChat(cfg.RunsDir, *chatID)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	kind := "builder_update"
	if *statusStr == string(state.StatusBlocked) {
		kind = "builder_blocked"
	}
	if err == nil {
		m.Status = state.RunStatus(*statusStr)
		m.Summary = *summary
		if *pr != "" {
			m.PR = *pr
		}
		if saveErr := state.Save(m); saveErr != nil {
			return saveErr
		}
	}
	ev, err := inbox.New(cfg.StateDir).Append(inbox.Event{
		Kind:      kind,
		ChatID:    *chatID,
		App:       m.App,
		Repo:      m.Repo,
		Status:    *statusStr,
		Summary:   *summary,
		PR:        *pr,
		RunDir:    m.Dir,
		RexWindow: m.RexWindowLabel,
	})
	if err != nil {
		return err
	}
	fmt.Printf("queued %s (%s) for Fable coordinator\n", ev.ID, ev.Kind)
	return nil
}

var errCoordinatorDialog = errors.New("coordinator pane shows a dialog or menu")

var (
	alertMu   sync.Mutex
	alertedAt time.Time
)

// alertBlockedDrain tells the person at the Mac that the inbox is held, at most once every 10 minutes:
// `FEEDBACK_ALERT_CMD <message>` when set, else a macOS notification.
func alertBlockedDrain(pending int, marker string) {
	alertMu.Lock()
	defer alertMu.Unlock()
	if time.Since(alertedAt) < 10*time.Minute {
		return
	}
	alertedAt = time.Now()
	msg := fmt.Sprintf("Feedback coordinator pane shows a dialog (%q). %d inbox event(s) are held until it is dismissed.", marker, pending)
	log.Printf("ALERT: %s", msg)
	var cmd *exec.Cmd
	if custom := strings.TrimSpace(os.Getenv("FEEDBACK_ALERT_CMD")); custom != "" {
		cmd = exec.Command(custom, msg)
	} else {
		cmd = exec.Command("osascript", "-e", fmt.Sprintf("display notification %q with title %q", msg, "rex-runner"))
	}
	if err := cmd.Start(); err != nil {
		log.Printf("alert command failed: %v", err)
		return
	}
	go func() { _ = cmd.Wait() }()
}

func drainInbox(ctx context.Context, cfg config.Config, rc *rex.Client) (int, error) {
	q := inbox.New(cfg.StateDir)
	events, nextLine, err := q.Pending()
	if err != nil || len(events) == 0 {
		return 0, err
	}
	coord, err := ensureCoordinator(ctx, cfg, rc)
	if err != nil {
		return 0, err
	}
	if coord.BlockID == "" {
		return 0, errors.New("coordinator Rex block ID is empty")
	}
	// A dialog or menu in the pane would swallow the text, so nothing is sent or acked while one is open.
	screen, err := rc.Capture(ctx, coord.SessionID, coord.BlockID)
	if err != nil {
		return 0, fmt.Errorf("read coordinator pane before drain: %w", err)
	}
	if marker := rex.DialogMarker(screen); marker != "" {
		alertBlockedDrain(len(events), marker)
		return 0, fmt.Errorf("%w (%q on screen); %d event(s) kept", errCoordinatorDialog, marker, len(events))
	}
	msg := inbox.FormatBatch(events)
	if err := rc.SendPrompt(ctx, coord.SessionID, coord.BlockID, msg); err != nil {
		return 0, err
	}
	if err := q.Ack(nextLine); err != nil {
		return 0, err
	}
	return len(events), nil
}

func cmdDrain(ctx context.Context, cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("drain", flag.ExitOnError)
	dryRun := fs.Bool("dry-run", false, "print formatted batch without sending to Fable")
	_ = fs.Parse(args)

	q := inbox.New(cfg.StateDir)
	if *dryRun {
		events, _, err := q.Pending()
		if err != nil {
			return err
		}
		if len(events) == 0 {
			fmt.Println("inbox empty")
			return nil
		}
		fmt.Println(inbox.FormatBatch(events))
		return nil
	}
	n, err := drainInbox(ctx, cfg, rex.NewClient(cfg.RexBinary))
	if err != nil {
		return err
	}
	fmt.Printf("drained %d event(s) to %s\n", n, cfg.CoordWindow)
	return nil
}

func cmdReap(ctx context.Context, cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("reap", flag.ExitOnError)
	ttl := fs.Duration("ttl", 24*time.Hour, "idle duration before reaping finished runs")
	dryRun := fs.Bool("dry-run", false, "report decisions without closing windows or modifying run.json")
	_ = fs.Parse(args)

	rc := rex.NewClient(cfg.RexBinary)
	decisions, err := reaper.Sweep(ctx, reaper.Options{
		RunsDir:     cfg.RunsDir,
		TTL:         *ttl,
		DryRun:      *dryRun,
		CloseWindow: rc.CloseWindow,
	})
	if err != nil {
		return err
	}
	for _, d := range decisions {
		fmt.Printf("%-14s %-8s %s\n", d.ChatID, d.Action, d.Reason)
		if !*dryRun && d.Action == "kept" {
			_, _ = inbox.New(cfg.StateDir).Append(inbox.Event{
				Kind:    "reap_notice",
				ChatID:  d.ChatID,
				Status:  "kept",
				Summary: "Reaper kept run folder: " + d.Reason,
			})
		}
	}
	if len(decisions) == 0 {
		fmt.Println("reap: no runs to evaluate")
	}
	return nil
}

func cmdServe(ctx context.Context, cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	claimApps := fs.String("claim-apps", "", "comma-separated apps opted into Rex claiming (empty = observe only, Orca untouched)")
	reapEvery := fs.Duration("reap-every", 10*time.Minute, "periodic deterministic reaper interval")
	reapTTL := fs.Duration("reap-ttl", 24*time.Hour, "idle TTL before reaping")
	_ = fs.Parse(args)

	baseClaimApps := config.ParseAppList(*claimApps)
	cfg.ClaimApps = config.LoadRuntimeClaimApps(cfg.StateDir, baseClaimApps)
	rc := rex.NewClient(cfg.RexBinary)
	coord, err := ensureCoordinator(ctx, cfg, rc)
	if err != nil {
		return fmt.Errorf("boot coordinator: %w", err)
	}
	log.Printf("serve started: session=%s coord_block=%s claim_apps=%v", coord.SessionID, coord.BlockID, cfg.ClaimApps)

	var (
		mu         sync.Mutex
		coordState = "idle"
	)
	tryDrain := func() {
		mu.Lock()
		ready := coordState == "idle" || coordState == "done" || coordState == "clear"
		mu.Unlock()
		if !ready {
			return
		}
		if n, err := drainInbox(ctx, cfg, rc); err != nil {
			log.Printf("drain error: %v", err)
		} else if n > 0 {
			log.Printf("drained %d event(s) to Fable", n)
		}
	}

	// Stream Rex OSC 7501 events so inbox drains only when Fable is idle/done.
	go func() {
		for ctx.Err() == nil {
			err := rc.StreamProgramStatus(ctx, coord.SessionID, func(ev rex.ProgramStatusEvent) {
				if ev.BlockID != coord.BlockID {
					return
				}
				mu.Lock()
				coordState = ev.State
				mu.Unlock()
				log.Printf("coordinator status: state=%s kind=%s", ev.State, ev.Kind)
				if ev.State == "idle" || ev.State == "done" || ev.State == "clear" {
					tryDrain()
				}
			})
			if ctx.Err() != nil {
				return
			}
			log.Printf("rex events stream ended (%v); reconnecting in 3s", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(3 * time.Second):
			}
		}
	}()

	// Worker wake-up loop (hot-reloads config.json claim_apps so switching apps needs no restart).
	if cfg.WorkerURL != "" && cfg.RunnerToken != "" {
		wc := worker.NewClient(cfg.WorkerURL, cfg.RunnerToken)
		go func() {
			var seq *int
			for ctx.Err() == nil {
				activeApps := config.LoadRuntimeClaimApps(cfg.StateDir, baseClaimApps)
				if len(activeApps) == 0 {
					select {
					case <-ctx.Done():
						return
					case <-time.After(10 * time.Second):
						continue
					}
				}
				nextSeq, supported, err := wc.Wait(ctx, seq, 25*time.Second)
				if err != nil {
					log.Printf("worker wait error: %v", err)
					time.Sleep(5 * time.Second)
					continue
				}
				if supported {
					seq = &nextSeq
				}
				work, err := wc.Poll(ctx, true, "")
				if err != nil {
					log.Printf("worker poll error: %v", err)
					continue
				}
				for _, item := range work {
					if !activeApps[item.App] {
						continue // Leave non-opted-in apps untouched for Python Orca runner.
					}
					if !item.First {
						if _, err := state.LoadChat(cfg.StateDir, item.Chat); err != nil {
							continue // A reply in a chat Orca started: Orca keeps it.
						}
					}
					claimed, err := wc.Claim(ctx, item)
					if err != nil || claimed == nil {
						continue
					}
					kind := "new_chat"
					rec, loadErr := state.LoadChat(cfg.StateDir, claimed.Chat)
					if loadErr == nil {
						kind = "user_reply"
					} else {
						rec = state.ChatRecord{
							ChatID: claimed.Chat,
							App:    claimed.App,
							Login:  claimed.Login,
							Repo:   claimed.Repo,
							Role:   claimed.Role,
							Title:  claimed.Title,
						}
					}
					_ = state.SaveChat(cfg.StateDir, rec)
					act := "Coordinator reviewing"
					msgs := make([]worker.AgentMessage, 0, len(rec.Messages))
					for _, m := range rec.Messages {
						msgs = append(msgs, worker.AgentMessage{ID: m.ID, Text: m.Text, At: m.At})
					}
					_ = wc.PostAgent(ctx, worker.AgentSidePayload{
						App:       claimed.App,
						Login:     claimed.Login,
						Chat:      claimed.Chat,
						Messages:  msgs,
						IsWorking: true,
						Activity:  &act,
					})
					_, _ = inbox.New(cfg.StateDir).Append(inbox.Event{
						Kind:   kind,
						ChatID: claimed.Chat,
						App:    claimed.App,
						Repo:   claimed.Repo,
						Summary: fmt.Sprintf(
							"%s (%s): %s | Reply via: rex-runner reply --chat %s --text \"...\"",
							claimed.Login, claimed.Role, truncate(claimed.Text, 240), claimed.Chat,
						),
					})
					_ = wc.Result(ctx, item, "delivered", "queued for Fable coordinator")
					tryDrain()
				}
				if !supported {
					time.Sleep(15 * time.Second)
				}
			}
		}()
	}

	drainTicker := time.NewTicker(5 * time.Second)
	defer drainTicker.Stop()
	statusTicker := time.NewTicker(15 * time.Second)
	defer statusTicker.Stop()
	builderTicker := time.NewTicker(30 * time.Second)
	defer builderTicker.Stop()
	reapTicker := time.NewTicker(*reapEvery)
	defer reapTicker.Stop()

	if cfg.WorkerURL != "" && cfg.RunnerToken != "" {
		cfg.ClaimApps = config.LoadRuntimeClaimApps(cfg.StateDir, baseClaimApps)
		_ = pushLiveStatus(ctx, cfg, rc, "idle", true)
	}

	for {
		select {
		case <-ctx.Done():
			log.Println("serve stopping cleanly")
			return nil
		case <-drainTicker.C:
			tryDrain()
		case <-statusTicker.C:
			if cfg.WorkerURL != "" && cfg.RunnerToken != "" {
				mu.Lock()
				st := coordState
				mu.Unlock()
				cfg.ClaimApps = config.LoadRuntimeClaimApps(cfg.StateDir, baseClaimApps)
				if err := pushLiveStatus(ctx, cfg, rc, st, true); err != nil {
					log.Printf("push-status error: %v", err)
				}
			}
		case <-builderTicker.C:
			checkBuilders(ctx, cfg, rc)
		case <-reapTicker.C:
			decisions, err := reaper.Sweep(ctx, reaper.Options{
				RunsDir:     cfg.RunsDir,
				TTL:         *reapTTL,
				CloseWindow: rc.CloseWindow,
			})
			if err != nil {
				log.Printf("reap error: %v", err)
				continue
			}
			for _, d := range decisions {
				if d.Action == "reaped" || d.Action == "kept" {
					log.Printf("reap %s: %s (%s)", d.ChatID, d.Action, d.Reason)
				}
			}
		}
	}
}

func newUUIDv4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func truncate(s string, max int) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if len(s) <= max {
		return s
	}
	return s[:max-1] + "…"
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}
