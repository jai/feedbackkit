package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

// shippedRelease, shippedCommit and shipped mirror the Worker's `shipped` contract (worker/src/shipped.ts).
type shippedRelease struct {
	Tag        string `json:"tag"`
	Name       string `json:"name"`
	URL        string `json:"url"`
	Prerelease bool   `json:"prerelease"`
}

type shippedCommit struct {
	SHA     string          `json:"sha"`
	Title   string          `json:"title"`
	At      *string         `json:"at"`
	URL     string          `json:"url"`
	CI      *string         `json:"ci"`
	Release *shippedRelease `json:"release"`
}

type shipped struct {
	Commits []shippedCommit   `json:"commits"`
	PRs     []json.RawMessage `json:"prs"`
}

// shipFlags collects repeated `--ship owner/repo@sha[@tag]` values.
type shipFlags []string

func (s *shipFlags) String() string     { return strings.Join(*s, ",") }
func (s *shipFlags) Set(v string) error { *s = append(*s, v); return nil }

var shipSpec = regexp.MustCompile(`^([\w.-]+/[\w.-]+)@([0-9a-f]{7,40})(?:@([\w./-]+))?$`)

// ghAPI runs `gh api <path>` as the jai-agents app for repo and returns the JSON body. A variable so tests can stub it.
var ghAPI = func(repo, path string) ([]byte, error) {
	gh := "/opt/homebrew/bin/gh"
	if _, err := os.Stat(gh); err != nil {
		gh = "gh"
	}
	cmd := exec.Command(gh, "api", path)
	cmd.Env = os.Environ()
	if tok, err := exec.Command("jai-agents-token", repo).Output(); err == nil && len(strings.TrimSpace(string(tok))) > 0 {
		cmd.Env = append(cmd.Env, "GH_TOKEN="+strings.TrimSpace(string(tok)))
	}
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("gh api %s: %w", path, err)
	}
	return out, nil
}

// resolveShipped turns `owner/repo@sha[@tag]` specs into the Worker's `shipped` JSON, reading each commit
// (and release, when a tag is given) from GitHub so the title, date and links are real.
func resolveShipped(specs []string) (json.RawMessage, error) {
	out := shipped{Commits: []shippedCommit{}, PRs: []json.RawMessage{}}
	for _, spec := range specs {
		m := shipSpec.FindStringSubmatch(strings.TrimSpace(spec))
		if m == nil {
			return nil, fmt.Errorf("--ship %q: want owner/repo@sha[@release-tag]", spec)
		}
		repo, sha, tag := m[1], m[2], m[3]
		raw, err := ghAPI(repo, "repos/"+repo+"/commits/"+sha)
		if err != nil {
			return nil, err
		}
		var c struct {
			SHA     string `json:"sha"`
			HTMLURL string `json:"html_url"`
			Commit  struct {
				Message   string `json:"message"`
				Committer struct {
					Date string `json:"date"`
				} `json:"committer"`
			} `json:"commit"`
		}
		if err := json.Unmarshal(raw, &c); err != nil || c.SHA == "" {
			return nil, fmt.Errorf("--ship %q: commit not readable from GitHub", spec)
		}
		title, _, _ := strings.Cut(c.Commit.Message, "\n")
		commit := shippedCommit{SHA: c.SHA, Title: truncate(title, 300), URL: c.HTMLURL}
		if c.Commit.Committer.Date != "" {
			at := c.Commit.Committer.Date
			commit.At = &at
		}
		if tag != "" {
			raw, err := ghAPI(repo, "repos/"+repo+"/releases/tags/"+tag)
			if err != nil {
				return nil, err
			}
			var r struct {
				TagName    string `json:"tag_name"`
				Name       string `json:"name"`
				HTMLURL    string `json:"html_url"`
				Prerelease bool   `json:"prerelease"`
			}
			if err := json.Unmarshal(raw, &r); err != nil || r.TagName == "" {
				return nil, fmt.Errorf("--ship %q: release %s not readable from GitHub", spec, tag)
			}
			name := r.Name
			if name == "" {
				name = r.TagName
			}
			commit.Release = &shippedRelease{Tag: r.TagName, Name: name, URL: r.HTMLURL, Prerelease: r.Prerelease}
		}
		out.Commits = append(out.Commits, commit)
	}
	return json.Marshal(out)
}
