package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

const ManifestName = "run.json"

// RunStatus represents the lifecycle state of an ephemeral feedback builder run.
type RunStatus string

const (
	StatusActive  RunStatus = "active"
	StatusBlocked RunStatus = "blocked"
	StatusDone    RunStatus = "done"
	StatusFailed  RunStatus = "failed"
	StatusKept    RunStatus = "kept"
	StatusReaped  RunStatus = "reaped"
)

// RunManifest is persisted as `<run_dir>/run.json` so a reboot or crash can
// resume the exact builder session in its own folder.
type RunManifest struct {
	Version        int       `json:"version"`
	ChatID         string    `json:"chat_id"`
	App            string    `json:"app"`
	Repo           string    `json:"repo"`
	Branch         string    `json:"branch,omitempty"`
	Dir            string    `json:"dir"`
	Agent          string    `json:"agent"` // claude | codex | agy
	Model          string    `json:"model,omitempty"`
	SessionID      string    `json:"session_id,omitempty"`
	RexSessionID   string    `json:"rex_session_id,omitempty"`
	RexWindowID    string    `json:"rex_window_id,omitempty"`
	RexWindowLabel string    `json:"rex_window_label,omitempty"`
	RexBlockID     string    `json:"rex_block_id,omitempty"`
	Status         RunStatus `json:"status"`
	Summary        string    `json:"summary,omitempty"`
	PR             string    `json:"pr,omitempty"`
	KeptReason     string    `json:"kept_reason,omitempty"`
	// StuckReason is why the runner last found this active builder not working; empty when it looked fine.
	StuckReason string    `json:"stuck_reason,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// IsTerminal reports whether the run no longer needs resuming on reboot.
func (m RunManifest) IsTerminal() bool {
	return m.Status == StatusDone || m.Status == StatusReaped || m.Status == StatusFailed
}

// ManifestPath returns `<dir>/run.json`.
func ManifestPath(runDir string) string {
	return filepath.Join(runDir, ManifestName)
}

// WriteAtomic writes JSON to path via a temp file + rename with 0600 permissions.
func WriteAtomic(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	tmp := fmt.Sprintf("%s.tmp.%d", path, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// Save writes the manifest atomically to `<m.Dir>/run.json`.
func Save(m RunManifest) error {
	if m.Dir == "" {
		return errors.New("run manifest dir is empty")
	}
	if m.Version == 0 {
		m.Version = 1
	}
	now := time.Now().UTC()
	if m.CreatedAt.IsZero() {
		m.CreatedAt = now
	}
	m.UpdatedAt = now
	return WriteAtomic(ManifestPath(m.Dir), m)
}

// Load reads `<runDir>/run.json`.
func Load(runDir string) (RunManifest, error) {
	var m RunManifest
	raw, err := os.ReadFile(ManifestPath(runDir))
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return m, fmt.Errorf("parse %s: %w", ManifestPath(runDir), err)
	}
	return m, nil
}

// ListAll scans `<runsDir>/*/run.json`, sorted newest-updated first.
func ListAll(runsDir string) ([]RunManifest, error) {
	entries, err := os.ReadDir(runsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []RunManifest
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(runsDir, e.Name())
		m, err := Load(dir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].UpdatedAt.After(out[j].UpdatedAt)
	})
	return out, nil
}

// FindByChat locates a run manifest by chat ID under runsDir.
func FindByChat(runsDir, chatID string) (RunManifest, error) {
	direct := filepath.Join(runsDir, chatID)
	if m, err := Load(direct); err == nil {
		return m, nil
	}
	all, err := ListAll(runsDir)
	if err != nil {
		return RunManifest{}, err
	}
	for _, m := range all {
		if m.ChatID == chatID {
			return m, nil
		}
	}
	return RunManifest{}, os.ErrNotExist
}
