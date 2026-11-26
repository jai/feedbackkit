package main

import (
	"reflect"
	"testing"

	"github.com/jai/feedbackkit/rex-runner/prompts"
)

func TestBuilderCommandPassesClaudeConfigDir(t *testing.T) {
	got, err := builderCommand("claude", "", "sid", "do it", "/state/prompts/builder.md", "/tmp/claude-two", false)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"env", "REX_SESSION_NAMING=false", "CLAUDE_CONFIG_DIR=/tmp/claude-two", "claude", "--dangerously-skip-permissions",
		"--append-system-prompt-file", "/state/prompts/builder.md", "--system-prompt-snapshot", "off",
		"--session-id", "sid", "do it",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestBuilderCommandWithoutConfigDirIsPlainClaude(t *testing.T) {
	got, err := builderCommand("claude", "", "sid", "", "/state/prompts/builder.md", "", true)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"env", "REX_SESSION_NAMING=false", "claude", "--dangerously-skip-permissions",
		"--append-system-prompt-file", "/state/prompts/builder.md", "--system-prompt-snapshot", "off",
		"--resume", "sid",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestBuilderCommandConfigDirLeavesCodexAlone(t *testing.T) {
	got, err := builderCommand("codex", "", "", "do it", "/state/prompts/builder.md", "/tmp/claude-two", false)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"codex", "--yolo", "do it\n\n---\n\n" + prompts.Builder()}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}
