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
  report   Record builder progress/completion and append to Fable's FIFO inbox
  drain    Deliver queued inbox.jsonl events to Fable's Rex block and ack cursor
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
	if sess, err := rc.FindSessionByLabel(ctx, cfg.SessionName); err == nil && sess != nil {
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

func pushLiveStatus(ctx context.Context, cfg config.Config, rc *rex.Client, coordState string) error {
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
	return worker.NewClient(cfg.WorkerURL, cfg.RunnerToken).PushRexStatus(ctx, worker.RexStatusPayload{
		SessionName:       snap.SessionName,
		SessionActive:     snap.SessionID != "",
		CoordinatorActive: snap.CoordBlockID != "",
		CoordinatorState:  coordState,
		InboxPending:      snap.InboxPending,
		ClaimApps:         snap.ClaimApps,
		Runs:              runs,
	})
}

func cmdPushStatus(ctx context.Context, cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("push-status", flag.ExitOnError)
	coordState := fs.String("coord-state", "idle", "current coordinator OSC 7501 state")
	_ = fs.Parse(args)

	if err := pushLiveStatus(ctx, cfg, rex.NewClient(cfg.RexBinary), *coordState); err != nil {
		return err
	}
	fmt.Printf("pushed Rex status to %s/runner/rex-status\n", strings.TrimRight(cfg.WorkerURL, "/"))
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

	sess, err := rc.FindSessionByLabel(ctx, cfg.SessionName)
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

func builderCommand(agent, model, sessionID, prompt string, resume bool) ([]string, error) {
	switch agent {
	case "claude":
		args := []string{"claude", "--dangerously-skip-permissions"}
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
		cmdArgs, err := builderCommand(m.Agent, m.Model, m.SessionID, "", true)
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
	cmdArgs, err := builderCommand(*agent, *model, sessionID, *prompt, false)
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

	cfg.ClaimApps = config.ParseAppList(*claimApps)
	rc := rex.NewClient(cfg.RexBinary)
	coord, err := ensureCoordinator(ctx, cfg, rc)
	if err != nil {
		return fmt.Errorf("boot coordinator: %w", err)
	}
	log.Printf("serve started: session=%s coord_block=%s claim_apps=%q", coord.SessionID, coord.BlockID, *claimApps)

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

	// Optional Worker wake-up loop for explicitly opted-in apps only.
	if len(cfg.ClaimApps) > 0 && cfg.WorkerURL != "" && cfg.RunnerToken != "" {
		wc := worker.NewClient(cfg.WorkerURL, cfg.RunnerToken)
		go func() {
			var seq *int
			for ctx.Err() == nil {
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
					if !cfg.ClaimApps[item.App] {
						continue // Leave non-opted-in apps untouched for Python Orca runner.
					}
					claimed, err := wc.Claim(ctx, item)
					if err != nil || claimed == nil {
						continue
					}
					_, _ = inbox.New(cfg.StateDir).Append(inbox.Event{
						Kind:    "new_chat",
						ChatID:  claimed.Chat,
						App:     claimed.App,
						Repo:    claimed.Repo,
						Summary: fmt.Sprintf("%s (%s): %s", claimed.Login, claimed.Role, truncate(claimed.Text, 240)),
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
	reapTicker := time.NewTicker(*reapEvery)
	defer reapTicker.Stop()

	if cfg.WorkerURL != "" && cfg.RunnerToken != "" {
		_ = pushLiveStatus(ctx, cfg, rc, "idle")
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
				if err := pushLiveStatus(ctx, cfg, rc, st); err != nil {
					log.Printf("push-status error: %v", err)
				}
			}
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
