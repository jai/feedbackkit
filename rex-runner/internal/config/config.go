package config

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const (
	DefaultSessionName   = "feedback-loop"
	DefaultCoordWindow   = "fable-coordinator"
	DefaultCoordLauncher = "cly"
	DefaultWorkerURL     = "https://featurekit.jai-f89.workers.dev"
)

// Config holds runtime paths and options for rex-runner.
type Config struct {
	SessionName   string
	CoordWindow   string
	CoordDir      string
	CoordLauncher string
	// BuilderConfigDir is passed to Claude builders as CLAUDE_CONFIG_DIR, so they run on that Claude account.
	// Empty leaves the builder on the default account.
	BuilderConfigDir string
	RunsDir          string
	StateDir         string
	CredsPath        string
	RexBinary        string
	WorkerURL        string
	RunnerToken      string
	// ClaimApps restricts which apps rex-runner may claim from the Worker.
	// Empty by default so rex-runner is strictly nondestructive to the existing Python/Orca runner.
	ClaimApps map[string]bool
}

// Default returns machine-local defaults rooted under $HOME.
func Default() Config {
	home, _ := os.UserHomeDir()
	return Config{
		SessionName:      envOr("FEEDBACK_REX_SESSION", DefaultSessionName),
		CoordWindow:      envOr("FEEDBACK_COORD_WINDOW", DefaultCoordWindow),
		CoordDir:         envOr("FEEDBACK_COORD_DIR", filepath.Join(home, "Developer", "feedback-coordinator")),
		CoordLauncher:    envOr("FEEDBACK_COORD_LAUNCHER", DefaultCoordLauncher),
		BuilderConfigDir: envOr("FEEDBACK_BUILDER_CONFIG_DIR", ""),
		RunsDir:          envOr("FEEDBACK_RUNS_DIR", filepath.Join(home, "Developer", "feedback-runs")),
		StateDir:         envOr("FEEDBACK_REX_STATE_DIR", filepath.Join(home, "Library", "Application Support", "feedbackkit-rex-runner")),
		CredsPath:        envOr("FEEDBACK_CREDS_PATH", filepath.Join(home, ".credentials", "feedbackkit")),
		RexBinary:        envOr("REX_BIN", "rex"),
		ClaimApps:        map[string]bool{},
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
	candidates := []string{c.CredsPath}
	if home, err := os.UserHomeDir(); err == nil {
		alt := filepath.Join(home, ".credentials", "featurekit")
		if alt != c.CredsPath {
			candidates = append(candidates, alt)
		}
	}
	for _, path := range candidates {
		if err := c.readCredFile(path); err != nil {
			return err
		}
	}
	if c.WorkerURL == "" && c.RunnerToken != "" {
		c.WorkerURL = DefaultWorkerURL
	}
	return nil
}

func (c *Config) readCredFile(path string) error {
	f, err := os.Open(path)
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

// LoadRuntimeClaimApps reads `<stateDir>/config.json` (`{"claim_apps": [...]}`) if present
// and merges it with any CLI-provided app allowlist so switching apps requires no restart.
func LoadRuntimeClaimApps(stateDir string, base map[string]bool) map[string]bool {
	out := map[string]bool{}
	for k, v := range base {
		if v {
			out[k] = true
		}
	}
	raw, err := os.ReadFile(filepath.Join(stateDir, "config.json"))
	if err != nil {
		return out
	}
	var file struct {
		ClaimApps []string `json:"claim_apps"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		return out
	}
	for _, app := range file.ClaimApps {
		slug := strings.TrimSpace(app)
		if slug != "" {
			out[slug] = true
		}
	}
	return out
}

// LoadRuntimeBuilderConfigDir returns the Claude config dir for builders: `FEEDBACK_BUILDER_CONFIG_DIR` (already in
// base) wins, else `builder_config_dir` in `<stateDir>/config.json`, so `spawn` from any shell and the launchd
// `serve` agree without sharing an environment.
func LoadRuntimeBuilderConfigDir(stateDir, base string) string {
	if base != "" {
		return base
	}
	raw, err := os.ReadFile(filepath.Join(stateDir, "config.json"))
	if err != nil {
		return ""
	}
	var file struct {
		BuilderConfigDir string `json:"builder_config_dir"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		return ""
	}
	return strings.TrimSpace(file.BuilderConfigDir)
}

// LoadRuntimeCoordLauncher returns the coordinator's launcher: `FEEDBACK_COORD_LAUNCHER` wins, else `coord_launcher`
// in `<stateDir>/config.json`, else base.
func LoadRuntimeCoordLauncher(stateDir, base string) string {
	if strings.TrimSpace(os.Getenv("FEEDBACK_COORD_LAUNCHER")) != "" {
		return base
	}
	raw, err := os.ReadFile(filepath.Join(stateDir, "config.json"))
	if err != nil {
		return base
	}
	var file struct {
		CoordLauncher string `json:"coord_launcher"`
	}
	if err := json.Unmarshal(raw, &file); err != nil || strings.TrimSpace(file.CoordLauncher) == "" {
		return base
	}
	return strings.TrimSpace(file.CoordLauncher)
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
