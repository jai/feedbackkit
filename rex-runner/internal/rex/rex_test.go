package rex

import (
	"context"
	"reflect"
	"testing"
)

func TestParseProgramStatusEvent(t *testing.T) {
	line := []byte(`{"event":{"type":"block_event","payload":{"block_id":"block:123","name":"program_status_changed","payload":{"record":{"state":"blocked","kind":"question","app":"antigravity","msg":"Approve deploy?"}}}}}`)
	ev, ok := ParseProgramStatusEvent(line)
	if !ok {
		t.Fatalf("expected parse ok")
	}
	if ev.BlockID != "block:123" || ev.State != "blocked" || ev.Kind != "question" || ev.App != "antigravity" {
		t.Fatalf("unexpected parsed event: %+v", ev)
	}

	other := []byte(`{"event":{"type":"block_event","payload":{"block_id":"block:123","name":"bell","payload":{}}}}`)
	if _, ok := ParseProgramStatusEvent(other); ok {
		t.Fatalf("expected non-status event to be ignored")
	}
}

func TestSendPromptCallsSendAndReturn(t *testing.T) {
	var calls [][]string
	c := &Client{
		Bin: "rex",
		Exec: func(_ context.Context, _ []byte, name string, args ...string) ([]byte, error) {
			calls = append(calls, append([]string{name}, args...))
			return nil, nil
		},
	}
	if err := c.SendPrompt(context.Background(), "session:1", "block:2", "hello"); err != nil {
		t.Fatalf("send prompt: %v", err)
	}
	want := [][]string{
		{"rex", "send", "-s", "session:1", "-b", "block:2"},
		{"rex", "send-key", "-s", "session:1", "-b", "block:2", "enter"},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %#v, want %#v", calls, want)
	}
}
