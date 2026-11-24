package prompts

import (
	"os"
	"strings"
	"testing"
)

func TestPromptsAreTheTextUnderThePromptHeading(t *testing.T) {
	for name, c := range map[string]struct{ text, start string }{
		"builder.md":     {Builder(), "You are a builder in Jai's feedback loop."},
		"coordinator.md": {Coordinator(), "You are the coordinator, the manager of Jai's feedback loop."},
	} {
		if !strings.HasPrefix(c.text, c.start) {
			t.Errorf("%s: prompt starts %.60q, want %q", name, c.text, c.start)
		}
		if strings.Contains(c.text, "Approved by") || strings.Contains(c.text, "## Prompt") {
			t.Errorf("%s: reviewer notes leaked into the prompt", name)
		}
	}
}

// Rules that must survive an edit of either file.
func TestPromptsKeepTheRulesThatStopHarm(t *testing.T) {
	for _, rule := range []string{"AGENTS.ci.md", "Cube 04", "Automation Mode", "pkill", "Only Jai can"} {
		if !strings.Contains(Builder(), rule) {
			t.Errorf("builder.md lost %q", rule)
		}
		if !strings.Contains(Coordinator(), rule) {
			t.Errorf("coordinator.md lost %q", rule)
		}
	}
	if !strings.Contains(Builder(), "rename the Rex session") {
		t.Error("builder.md lost the rule against renaming the Rex session")
	}
}

func TestWriteFileReplacesAnOlderPrompt(t *testing.T) {
	dir := t.TempDir()
	for _, text := range []string{"old", "new"} {
		path, err := WriteFile(dir, "builder", text)
		if err != nil {
			t.Fatal(err)
		}
		if got, _ := os.ReadFile(path); string(got) != text+"\n" {
			t.Fatalf("got %q, want %q", got, text)
		}
	}
	if left, _ := os.ReadDir(dir + "/prompts"); len(left) != 1 {
		t.Fatalf("temporary files left: %v", left)
	}
}
