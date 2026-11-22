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
		"env", "CLAUDE_CONFIG_DIR=/tmp/claude-two", "claude", "--dangerously-skip-permissions",
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
	want := []string{"claude", "--dangerously-skip-permissions", "--resume", "sid"}
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
