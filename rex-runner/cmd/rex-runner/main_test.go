package main

import (
	"reflect"
	"testing"
)

func TestBuilderCommandPassesClaudeConfigDir(t *testing.T) {
	got, err := builderCommand("claude", "", "sid", "do it", "/tmp/claude-two", false)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"env", "REX_SESSION_NAMING=false", "CLAUDE_CONFIG_DIR=/tmp/claude-two", "claude", "--dangerously-skip-permissions",
		"--session-id", "sid", "do it",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestBuilderCommandWithoutConfigDirIsPlainClaude(t *testing.T) {
	got, err := builderCommand("claude", "", "sid", "", "", true)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"env", "REX_SESSION_NAMING=false", "claude", "--dangerously-skip-permissions", "--resume", "sid"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestBuilderCommandConfigDirLeavesCodexAlone(t *testing.T) {
	got, err := builderCommand("codex", "", "", "do it", "/tmp/claude-two", false)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"codex", "--yolo", "do it"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestBuilderCommandAgySpawnAndResume(t *testing.T) {
	orig := resolveAgyBin
	resolveAgyBin = func() string { return "/opt/homebrew/bin/agy" }
	defer func() { resolveAgyBin = orig }()

	got, err := builderCommand("agy", "gemini-4-neon-high", "", "fix bug", "/tmp/ignored", false)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"env", "REX_SESSION_NAMING=false", "/opt/homebrew/bin/agy",
		"--dangerously-skip-permissions", "--model", "gemini-4-neon-high", "-i", "fix bug",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("spawn got %q, want %q", got, want)
	}

	gotResume, err := builderCommand("agy", "gemini-4-neon-high", "", "", "", true)
	if err != nil {
		t.Fatal(err)
	}
	wantResume := []string{
		"env", "REX_SESSION_NAMING=false", "/opt/homebrew/bin/agy",
		"--dangerously-skip-permissions", "--model", "gemini-4-neon-high", "--continue",
	}
	if !reflect.DeepEqual(gotResume, wantResume) {
		t.Fatalf("resume got %q, want %q", gotResume, wantResume)
	}
}
