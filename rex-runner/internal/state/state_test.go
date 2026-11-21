package state

import (
	"path/filepath"
	"testing"
	"time"
)

func TestSaveLoadListAndFind(t *testing.T) {
	runsDir := t.TempDir()
	dirA := filepath.Join(runsDir, "fb-11111111")
	dirB := filepath.Join(runsDir, "fb-22222222")

	if err := Save(RunManifest{
		ChatID: "fb-11111111",
		App:    "agent-pager",
		Repo:   "jai/agent-pager",
		Dir:    dirA,
		Agent:  "claude",
		Status: StatusActive,
	}); err != nil {
		t.Fatalf("save A: %v", err)
	}
	time.Sleep(5 * time.Millisecond)
	if err := Save(RunManifest{
		ChatID: "fb-22222222",
		App:    "prhub",
		Repo:   "jai/prhub",
		Dir:    dirB,
		Agent:  "agy",
		Status: StatusDone,
	}); err != nil {
		t.Fatalf("save B: %v", err)
	}

	all, err := ListAll(runsDir)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 2 || all[0].ChatID != "fb-22222222" {
		t.Fatalf("unexpected order/count: %+v", all)
	}
	if all[0].IsTerminal() != true || all[1].IsTerminal() != false {
		t.Fatalf("unexpected IsTerminal: %+v", all)
	}

	found, err := FindByChat(runsDir, "fb-11111111")
	if err != nil || found.App != "agent-pager" {
		t.Fatalf("find: %+v, err=%v", found, err)
	}
}
