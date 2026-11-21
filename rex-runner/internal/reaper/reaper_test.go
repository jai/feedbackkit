package reaper

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/jai/feedbackkit/rex-runner/internal/state"
)

func TestSweepProtectsDirtyAndActiveRunsAndReapsCleanIdle(t *testing.T) {
	runsDir := t.TempDir()
	now := time.Now().UTC()
	old := now.Add(-48 * time.Hour)

	saveWithTime := func(m state.RunManifest, updated time.Time) {
		m.CreatedAt = updated
		m.UpdatedAt = updated
		if err := state.WriteAtomic(state.ManifestPath(m.Dir), m); err != nil {
			t.Fatalf("write manifest: %v", err)
		}
	}

	dirClean := filepath.Join(runsDir, "fb-clean")
	dirDirty := filepath.Join(runsDir, "fb-dirty")
	dirActive := filepath.Join(runsDir, "fb-active")

	saveWithTime(state.RunManifest{
		Version: 1, ChatID: "fb-clean", Dir: dirClean, Status: state.StatusDone,
		RexSessionID: "session:1", RexWindowID: "window:clean",
	}, old)
	saveWithTime(state.RunManifest{
		Version: 1, ChatID: "fb-dirty", Dir: dirDirty, Status: state.StatusDone,
		RexSessionID: "session:1", RexWindowID: "window:dirty",
	}, old)
	saveWithTime(state.RunManifest{
		Version: 1, ChatID: "fb-active", Dir: dirActive, Status: state.StatusActive,
	}, old)

	var closed []string
	decisions, err := Sweep(context.Background(), Options{
		RunsDir: runsDir,
		TTL:     24 * time.Hour,
		Now:     now,
		CheckGit: func(_ context.Context, dir string) (bool, string) {
			if dir == dirDirty {
				return false, "uncommitted changes"
			}
			return true, "clean"
		},
		CloseWindow: func(_ context.Context, _, windowID string) error {
			closed = append(closed, windowID)
			return nil
		},
	})
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}

	got := map[string]string{}
	for _, d := range decisions {
		got[d.ChatID] = d.Action
	}
	if got["fb-clean"] != "reaped" || got["fb-dirty"] != "kept" || got["fb-active"] != "skipped" {
		t.Fatalf("unexpected decisions: %+v", got)
	}
	if len(closed) != 1 || closed[0] != "window:clean" {
		t.Fatalf("unexpected closed windows: %v", closed)
	}

	reapedM, _ := state.Load(dirClean)
	keptM, _ := state.Load(dirDirty)
	if reapedM.Status != state.StatusReaped {
		t.Fatalf("expected reaped status, got %s", reapedM.Status)
	}
	if keptM.Status != state.StatusKept || keptM.KeptReason != "uncommitted changes" {
		t.Fatalf("expected kept status, got %+v", keptM)
	}
}
