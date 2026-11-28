package config

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const (
	DefaultSessionName     = "feedback-loop"
	DefaultCoordWindow     = "fable-coordinator"
	DefaultCoordAgent      = "claude"
	DefaultCoordLauncher   = "cly"
	DefaultCoordModel      = "claude-fable-5-2"
	DefaultAgyCoordModel   = "gemini-4-neon-medium"
	DefaultAgyBuilderModel = "gemini-4-neon-high"
	DefaultBuilderAgent    = "claude"
	DefaultWorkerURL       = "https://featurekit.jai-f89.workers.dev"
)

// Config holds runtime paths and options for rex-runner.
type Config struct {
	SessionName     string
	CoordWindow     string
	CoordDir        string
	CoordAgent      string
	CoordLauncher   string
	CoordModel      string
	ClaudeSwitchBin string
	BuilderAgent    string
	BuilderModel    string
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
		CoordAgent:       envOr("FEEDBACK_COORD_AGENT", DefaultCoordAgent),
		CoordLauncher:    envOr("FEEDBACK_COORD_LAUNCHER", DefaultCoordLauncher),
		CoordModel:       envOr("FEEDBACK_COORD_MODEL", envOr("FABLE_MODEL", DefaultCoordModel)),
		ClaudeSwitchBin:  envOr("CLAUDE_SWITCH_BIN", ""),
		BuilderAgent:     envOr("FEEDBACK_BUILDER_AGENT", DefaultBuilderAgent),
		BuilderModel:     envOr("FEEDBACK_BUILDER_MODEL", ""),
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
	return loadRuntimeString(stateDir, "coord_launcher", base)
}

// LoadRuntimeCoordAgent returns the coordinator agent (`claude` or `agy`): `FEEDBACK_COORD_AGENT` wins, else
// `coord_agent` in `<stateDir>/config.json`, else base.
func LoadRuntimeCoordAgent(stateDir, base string) string {
	if strings.TrimSpace(os.Getenv("FEEDBACK_COORD_AGENT")) != "" {
		return base
	}
	return loadRuntimeString(stateDir, "coord_agent", base)
}

// LoadRuntimeCoordModel returns the coordinator model: `FEEDBACK_COORD_MODEL` or `FABLE_MODEL` wins, else
// `coord_model` in `<stateDir>/config.json`, else base.
func LoadRuntimeCoordModel(stateDir, base string) string {
	if strings.TrimSpace(os.Getenv("FEEDBACK_COORD_MODEL")) != "" || strings.TrimSpace(os.Getenv("FABLE_MODEL")) != "" {
		return base
	}
	return loadRuntimeString(stateDir, "coord_model", base)
}

// LoadRuntimeBuilderAgent returns the default builder agent (`claude`, `codex`, or `agy`): `FEEDBACK_BUILDER_AGENT`
// wins, else `builder_agent` in `<stateDir>/config.json`, else base.
func LoadRuntimeBuilderAgent(stateDir, base string) string {
	if strings.TrimSpace(os.Getenv("FEEDBACK_BUILDER_AGENT")) != "" {
		return base
	}
	return loadRuntimeString(stateDir, "builder_agent", base)
}

// LoadRuntimeBuilderModel returns the default builder model: `FEEDBACK_BUILDER_MODEL` wins, else `builder_model` in
// `<stateDir>/config.json`, else base.
func LoadRuntimeBuilderModel(stateDir, base string) string {
	if strings.TrimSpace(os.Getenv("FEEDBACK_BUILDER_MODEL")) != "" {
		return base
	}
	return loadRuntimeString(stateDir, "builder_model", base)
}

func loadRuntimeString(stateDir, key, fallback string) string {
	raw, err := os.ReadFile(filepath.Join(stateDir, "config.json"))
	if err != nil {
		return fallback
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return fallback
	}
	if v, ok := m[key].(string); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return fallback
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
