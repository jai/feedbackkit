package inbox

import (
	"strings"
	"testing"
)

func TestInboxFIFOAppendPendingAckAndFormat(t *testing.T) {
	q := New(t.TempDir())
	if _, err := q.Append(Event{Kind: "spawned", ChatID: "fb-aaa", App: "prhub", Summary: "Started tab"}); err != nil {
		t.Fatalf("append 1: %v", err)
	}
	if _, err := q.Append(Event{Kind: "builder_update", ChatID: "fb-aaa", Status: "done", Summary: "CI green", PR: "#42"}); err != nil {
		t.Fatalf("append 2: %v", err)
	}

	pending, cursor, err := q.Pending()
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if len(pending) != 2 || cursor != 2 {
		t.Fatalf("got %d pending, cursor=%d", len(pending), cursor)
	}
	formatted := FormatBatch(pending)
	if !strings.Contains(formatted, "[rex-runner inbox: 2 event(s)]") || !strings.Contains(formatted, "pr=#42") {
		t.Fatalf("unexpected formatted batch:\n%s", formatted)
	}

	if err := q.Ack(cursor); err != nil {
		t.Fatalf("ack: %v", err)
	}
	pending, _, err = q.Pending()
	if err != nil || len(pending) != 0 {
		t.Fatalf("expected 0 pending after ack, got %d (err=%v)", len(pending), err)
	}

	if _, err := q.Append(Event{Kind: "builder_blocked", ChatID: "fb-bbb", Summary: "Need approval"}); err != nil {
		t.Fatalf("append 3: %v", err)
	}
	pending, cursor, err = q.Pending()
	if err != nil || len(pending) != 1 || cursor != 3 || pending[0].ChatID != "fb-bbb" {
		t.Fatalf("unexpected post-ack pending: %+v cursor=%d err=%v", pending, cursor, err)
	}
}
