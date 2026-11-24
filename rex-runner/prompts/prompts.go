// Package prompts holds the standing prompts rex-runner gives its agents. The text lives in the .md files beside this
// one, so it can be reviewed and changed without touching Go.
package prompts

import (
	_ "embed"
	"os"
	"path/filepath"
	"strings"
)

//go:embed builder.md
var builderFile string

//go:embed coordinator.md
var coordinatorFile string

// Builder is the standing prompt of every builder.
func Builder() string { return body(builderFile) }

// Coordinator is the standing prompt of the feedback coordinator.
func Coordinator() string { return body(coordinatorFile) }

// WriteFile saves a prompt as <stateDir>/prompts/<name>.md for Claude to read at start. A file, not an argument: text on
// the command line would let a `pkill -f` pattern match every agent.
func WriteFile(stateDir, name, text string) (string, error) {
	dir := filepath.Join(stateDir, "prompts")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, name+".md")
	tmp, err := os.CreateTemp(dir, name+".*.tmp")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(text + "\n"); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	return path, os.Rename(tmp.Name(), path)
}

// body is the text under the file's "## Prompt" heading; what is above it is for reviewers.
func body(file string) string {
	_, text, _ := strings.Cut(file, "\n## Prompt\n")
	return strings.TrimSpace(text)
}
