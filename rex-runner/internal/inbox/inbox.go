package inbox

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/jai/feedbackkit/rex-runner/internal/state"
)

// Event is a serialized message queued for the Fable coordinator.
// Builders and the wake-up loop append Events to inbox.jsonl instead of
// writing directly to Fable's TTY, preventing concurrent output collisions.
type Event struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"` // new_chat | user_reply | spawned | builder_update | builder_blocked | reap_notice
	ChatID    string    `json:"chat_id,omitempty"`
	App       string    `json:"app,omitempty"`
	Repo      string    `json:"repo,omitempty"`
	Status    string    `json:"status,omitempty"`
	Summary   string    `json:"summary"`
	PR        string    `json:"pr,omitempty"`
	RunDir    string    `json:"run_dir,omitempty"`
	RexWindow string    `json:"rex_window,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type cursorFile struct {
	AckedLines int       `json:"acked_lines"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// Queue manages an append-only FIFO `inbox.jsonl` with an atomic ack cursor.
type Queue struct {
	Dir string
}

func New(dir string) *Queue {
	return &Queue{Dir: dir}
}

func (q *Queue) logPath() string    { return filepath.Join(q.Dir, "inbox.jsonl") }
func (q *Queue) cursorPath() string { return filepath.Join(q.Dir, "inbox.cursor.json") }
func (q *Queue) lockPath() string   { return filepath.Join(q.Dir, "inbox.lock") }

func (q *Queue) withLock(fn func() error) error {
	if err := os.MkdirAll(q.Dir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(q.lockPath(), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("flock inbox: %w", err)
	}
	defer func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }()
	return fn()
}

// Append adds one event atomically to inbox.jsonl.
func (q *Queue) Append(ev Event) (Event, error) {
	if ev.CreatedAt.IsZero() {
		ev.CreatedAt = time.Now().UTC()
	}
	if ev.ID == "" {
		ev.ID = fmt.Sprintf("ev-%d", ev.CreatedAt.UnixNano())
	}
	err := q.withLock(func() error {
		raw, err := json.Marshal(ev)
		if err != nil {
			return err
		}
		raw = append(raw, '\n')
		f, err := os.OpenFile(q.logPath(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = f.Write(raw)
		return err
	})
	return ev, err
}

// Pending returns all unacknowledged events and the next cursor line count.
func (q *Queue) Pending() ([]Event, int, error) {
	var events []Event
	var total int
	err := q.withLock(func() error {
		acked := q.readCursorLocked()
		all, err := q.readAllLocked()
		if err != nil {
			return err
		}
		total = len(all)
		if acked < len(all) {
			events = append(events, all[acked:]...)
		}
		return nil
	})
	return events, total, err
}

// Ack advances the cursor to at least nextLine.
func (q *Queue) Ack(nextLine int) error {
	return q.withLock(func() error {
		cur := q.readCursorLocked()
		if nextLine <= cur {
			return nil
		}
		return state.WriteAtomic(q.cursorPath(), cursorFile{
			AckedLines: nextLine,
			UpdatedAt:  time.Now().UTC(),
		})
	})
}

func (q *Queue) readCursorLocked() int {
	raw, err := os.ReadFile(q.cursorPath())
	if err != nil {
		return 0
	}
	var c cursorFile
	if err := json.Unmarshal(raw, &c); err != nil || c.AckedLines < 0 {
		return 0
	}
	return c.AckedLines
}

func (q *Queue) readAllLocked() ([]Event, error) {
	f, err := os.Open(q.logPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()

	var out []Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var ev Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			// Skip malformed lines rather than deadlocking the inbox.
			continue
		}
		out = append(out, ev)
	}
	return out, sc.Err()
}

// FormatBatch renders queued events into a compact prompt block for Fable.
func FormatBatch(events []Event) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[rex-runner inbox: %d event(s)]\n", len(events))
	for i, ev := range events {
		fmt.Fprintf(&b, "%d. [%s]", i+1, ev.Kind)
		if ev.ChatID != "" {
			fmt.Fprintf(&b, " chat=%s", ev.ChatID)
		}
		if ev.App != "" {
			fmt.Fprintf(&b, " app=%s", ev.App)
		}
		if ev.Repo != "" {
			fmt.Fprintf(&b, " repo=%s", ev.Repo)
		}
		if ev.Status != "" {
			fmt.Fprintf(&b, " status=%s", ev.Status)
		}
		if ev.RexWindow != "" {
			fmt.Fprintf(&b, " tab=%s", ev.RexWindow)
		}
		if ev.PR != "" {
			fmt.Fprintf(&b, " pr=%s", ev.PR)
		}
		b.WriteString("\n")
		if ev.Summary != "" {
			fmt.Fprintf(&b, "   %s\n", strings.TrimSpace(ev.Summary))
		}
		if ev.RunDir != "" {
			fmt.Fprintf(&b, "   dir: %s\n", ev.RunDir)
		}
	}
	return strings.TrimRight(b.String(), "\n")
}
