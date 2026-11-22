package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadRuntimeBuilderConfigDir(t *testing.T) {
	dir := t.TempDir()
	if got := LoadRuntimeBuilderConfigDir(dir, ""); got != "" {
		t.Fatalf("no file: got %q", got)
	}
	raw := []byte(`{"claim_apps": ["prhub"], "builder_config_dir": " /home/x/.claude-two "}`)
	if err := os.WriteFile(filepath.Join(dir, "config.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := LoadRuntimeBuilderConfigDir(dir, ""); got != "/home/x/.claude-two" {
		t.Fatalf("from file: got %q", got)
	}
	if got := LoadRuntimeBuilderConfigDir(dir, "/env/wins"); got != "/env/wins" {
		t.Fatalf("env wins: got %q", got)
	}
	if apps := LoadRuntimeClaimApps(dir, nil); !apps["prhub"] {
		t.Fatalf("claim_apps still read: %v", apps)
	}
}

func TestLoadRuntimeCoordLauncher(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("FEEDBACK_COORD_LAUNCHER", "")
	if got := LoadRuntimeCoordLauncher(dir, "cly"); got != "cly" {
		t.Fatalf("no file: got %q", got)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"coord_launcher": "cl1"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := LoadRuntimeCoordLauncher(dir, "cly"); got != "cl1" {
		t.Fatalf("from file: got %q", got)
	}
	t.Setenv("FEEDBACK_COORD_LAUNCHER", "cw")
	if got := LoadRuntimeCoordLauncher(dir, "cw"); got != "cw" {
		t.Fatalf("env wins: got %q", got)
	}
}
