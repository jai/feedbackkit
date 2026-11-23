package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestResolveShipped(t *testing.T) {
	old := ghAPI
	defer func() { ghAPI = old }()
	sha := strings.Repeat("a", 40)
	ghAPI = func(repo, path string) ([]byte, error) {
		if strings.Contains(path, "/commits/") {
			return []byte(`{"sha":"` + sha + `","html_url":"https://github.com/o/r/commit/` + sha + `","commit":{"message":"fix: a thing\n\nbody","committer":{"date":"2026-11-22T10:00:00Z"}}}`), nil
		}
		return []byte(`{"tag_name":"ios-v1.0.0","name":"","html_url":"https://github.com/o/r/releases/tag/ios-v1.0.0","prerelease":false}`), nil
	}
	raw, err := resolveShipped([]string{"o/r@aaaaaaa@ios-v1.0.0", "o/r@aaaaaaa"})
	if err != nil {
		t.Fatal(err)
	}
	var got shipped
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Commits) != 2 || got.Commits[0].SHA != sha || got.Commits[0].Title != "fix: a thing" {
		t.Fatalf("commits = %+v", got.Commits)
	}
	if r := got.Commits[0].Release; r == nil || r.Tag != "ios-v1.0.0" || r.Name != "ios-v1.0.0" {
		t.Fatalf("release = %+v", got.Commits[0].Release)
	}
	if got.Commits[1].Release != nil {
		t.Fatal("second commit should have no release")
	}
	if !strings.Contains(string(raw), `"prs":[]`) || !strings.Contains(string(raw), `"ci":null`) {
		t.Fatalf("shape: %s", raw)
	}
	if _, err := resolveShipped([]string{"not a spec"}); err == nil {
		t.Fatal("bad spec accepted")
	}
}
