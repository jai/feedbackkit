package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

const (
	DefaultSessionName   = "feedback-loop"
	DefaultCoordWindow   = "fable-coordinator"
	DefaultCoordLauncher = "cly"
)

// Config holds runtime paths and options for rex-runner.
type Config struct {
	SessionName   string
	CoordWindow   string
	CoordDir      string
	CoordLauncher string
	RunsDir       string
	StateDir      string
	CredsPath     string
	RexBinary     string
	WorkerURL     string
	RunnerToken   string
	// ClaimApps restricts which apps rex-runner may claim from the Worker.
	// Empty by default so rex-runner is strictly nondestructive to the existing Python/Orca runner.
	ClaimApps map[string]bool
}

// Default returns machine-local defaults rooted under $HOME.
func Default() Config {
	home, _ := os.UserHomeDir()
	return Config{
		SessionName:   envOr("FEEDBACK_REX_SESSION", DefaultSessionName),
		CoordWindow:   envOr("FEEDBACK_COORD_WINDOW", DefaultCoordWindow),
		CoordDir:      envOr("FEEDBACK_COORD_DIR", filepath.Join(home, "Developer", "feedback-coordinator")),
		CoordLauncher: envOr("FEEDBACK_COORD_LAUNCHER", DefaultCoordLauncher),
		RunsDir:       envOr("FEEDBACK_RUNS_DIR", filepath.Join(home, "Developer", "feedback-runs")),
		StateDir:      envOr("FEEDBACK_REX_STATE_DIR", filepath.Join(home, "Library", "Application Support", "feedbackkit-rex-runner")),
		CredsPath:     envOr("FEEDBACK_CREDS_PATH", filepath.Join(home, ".credentials", "feedbackkit")),
		RexBinary:     envOr("REX_BIN", "rex"),
		ClaimApps:     map[string]bool{},
	}
}

// LoadCredentials populates WorkerURL and RunnerToken from CredsPath if not already set.
func (c *Config) LoadCredentials() error {
	if c.WorkerURL == "" {
		c.WorkerURL = strings.TrimSpace(os.Getenv("FEEDBACKKIT_URL"))
	}
	if c.RunnerToken == "" {
		c.RunnerToken = strings.TrimSpace(os.Getenv("FEEDBACKKIT_RUNNER_TOKEN"))
	}
	if c.WorkerURL != "" && c.RunnerToken != "" {
		return nil
	}
	f, err := os.Open(c.CredsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		switch k {
		case "FEEDBACKKIT_URL":
			if c.WorkerURL == "" {
				c.WorkerURL = v
			}
		case "FEEDBACKKIT_RUNNER_TOKEN":
			if c.RunnerToken == "" {
				c.RunnerToken = v
			}
		}
	}
	return sc.Err()
}

// ParseAppList parses a comma-separated list of app slugs into a lookup set.
func ParseAppList(csv string) map[string]bool {
	out := map[string]bool{}
	for _, raw := range strings.Split(csv, ",") {
		slug := strings.TrimSpace(raw)
		if slug != "" {
			out[slug] = true
		}
	}
	return out
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
