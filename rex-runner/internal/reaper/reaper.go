package reaper

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/jai/feedbackkit/rex-runner/internal/state"
)

// Decision records what the reaper did (or would do under dry-run) for one run.
type Decision struct {
	ChatID string
	Action string // skipped | kept | reaped
	Reason string
}

// GitCheck inspects a directory for uncommitted changes or unpushed commits.
type GitCheck func(ctx context.Context, dir string) (clean bool, reason string)

// WindowCloser closes an open Rex window by ID.
type WindowCloser func(ctx context.Context, sessionID, windowID string) error

// Options controls a reaper sweep.
type Options struct {
	RunsDir     string
	TTL         time.Duration
	DryRun      bool
	Now         time.Time
	CheckGit    GitCheck
	CloseWindow WindowCloser
}

// Sweep inspects every run.json in RunsDir and deterministically cleans up idle,
// clean, pushed runs while protecting any folder with uncommitted or unpushed work.
func Sweep(ctx context.Context, opts Options) ([]Decision, error) {
	if opts.Now.IsZero() {
		opts.Now = time.Now().UTC()
	}
	if opts.TTL <= 0 {
		opts.TTL = 24 * time.Hour
	}
	checkGit := opts.CheckGit
	if checkGit == nil {
		checkGit = DefaultGitCheck
	}

	runs, err := state.ListAll(opts.RunsDir)
	if err != nil {
		return nil, err
	}
	var decisions []Decision
	for _, m := range runs {
		if m.Status == state.StatusReaped {
			continue
		}
		age := opts.Now.Sub(m.UpdatedAt)
		if age < opts.TTL {
			decisions = append(decisions, Decision{
				ChatID: m.ChatID,
				Action: "skipped",
				Reason: fmt.Sprintf("idle %s < ttl %s", age.Truncate(time.Second), opts.TTL),
			})
			continue
		}
		if m.Status == state.StatusActive || m.Status == state.StatusBlocked {
			decisions = append(decisions, Decision{
				ChatID: m.ChatID,
				Action: "skipped",
				Reason: fmt.Sprintf("status is %s", m.Status),
			})
			continue
		}

		clean, reason := checkGit(ctx, m.Dir)
		if !clean {
			decisions = append(decisions, Decision{
				ChatID: m.ChatID,
				Action: "kept",
				Reason: reason,
			})
			if !opts.DryRun {
				m.Status = state.StatusKept
				m.KeptReason = reason
				_ = state.Save(m)
			}
			continue
		}

		if !opts.DryRun {
			if opts.CloseWindow != nil && m.RexSessionID != "" && m.RexWindowID != "" {
				_ = opts.CloseWindow(ctx, m.RexSessionID, m.RexWindowID)
			}
			m.Status = state.StatusReaped
			m.KeptReason = ""
			_ = state.Save(m)
		}
		decisions = append(decisions, Decision{
			ChatID: m.ChatID,
			Action: "reaped",
			Reason: "idle past TTL and git clean/pushed",
		})
	}
	return decisions, nil
}

// DefaultGitCheck verifies that a run folder (if it contains a git repo/worktree)
// has no uncommitted edits and no commits absent from origin remotes.
func DefaultGitCheck(ctx context.Context, dir string) (bool, string) {
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return true, "folder already gone"
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); os.IsNotExist(err) {
		return true, "not a git checkout"
	}
	statusOut, err := runGit(ctx, dir, "status", "--porcelain")
	if err != nil {
		return false, fmt.Sprintf("git status failed: %v", err)
	}
	// Ignore our own run.json manifest when judging repo cleanliness.
	for _, line := range strings.Split(statusOut, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasSuffix(trimmed, state.ManifestName) {
			continue
		}
		return false, "uncommitted changes"
	}
	unpushed, err := runGit(ctx, dir, "log", "--oneline", "HEAD", "--not", "--remotes=origin")
	if err != nil {
		// No origin remote configured -> keep safely rather than guessing.
		return false, fmt.Sprintf("git unpushed check failed: %v", err)
	}
	if strings.TrimSpace(unpushed) != "" {
		return false, "unpushed commits"
	}
	return true, "clean"
}

func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%w (%s)", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}
