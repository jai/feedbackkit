package rex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// Session is one entry from `rex ls --json`.
type Session struct {
	SessionID string `json:"session_id"`
	Label     string `json:"label"`
}

// Window is one entry from `rex window ls --json`.
type Window struct {
	WindowID       string `json:"window_id"`
	Label          string `json:"label"`
	FocusedBlockID string `json:"focused_block_id"`
}

// CreatedWindow holds IDs returned by `rex window new --json` or `rex new --json`.
type CreatedWindow struct {
	SessionID string
	WindowID  string
	BlockID   string
}

// ProgramStatusEvent represents a Rex OSC 7501 `program_status_changed` event.
type ProgramStatusEvent struct {
	BlockID string
	State   string // idle | working | done | blocked | error | clear
	Kind    string // permission | question | auth
	App     string
	Msg     string
}

// ExecFunc abstracts command execution for deterministic tests.
type ExecFunc func(ctx context.Context, stdin []byte, name string, args ...string) ([]byte, error)

// Client wraps the local `rex` CLI.
type Client struct {
	Bin  string
	Exec ExecFunc
}

func NewClient(bin string) *Client {
	if bin == "" {
		bin = "rex"
	}
	return &Client{Bin: bin, Exec: defaultExec}
}

func defaultExec(ctx context.Context, stdin []byte, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if len(stdin) > 0 {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = strings.TrimSpace(stdout.String())
		}
		return stdout.Bytes(), fmt.Errorf("%s %s: %w (%s)", name, strings.Join(args, " "), err, msg)
	}
	return stdout.Bytes(), nil
}

func (c *Client) ListSessions(ctx context.Context) ([]Session, error) {
	out, err := c.Exec(ctx, nil, c.Bin, "ls", "--json")
	if err != nil {
		return nil, err
	}
	var resp struct {
		Sessions []Session `json:"sessions"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		return nil, fmt.Errorf("parse rex ls: %w", err)
	}
	return resp.Sessions, nil
}

func (c *Client) FindSessionByLabel(ctx context.Context, label string) (*Session, error) {
	sessions, err := c.ListSessions(ctx)
	if err != nil {
		return nil, err
	}
	for i := range sessions {
		if sessions[i].Label == label {
			return &sessions[i], nil
		}
	}
	return nil, nil
}

// RenameSession sets a session's label.
func (c *Client) RenameSession(ctx context.Context, sessionID, label string) error {
	_, err := c.Exec(ctx, nil, c.Bin, "session", "rename", sessionID, label)
	return err
}

func (c *Client) NewSession(ctx context.Context, label, windowLabel, cwd string, command []string) (CreatedWindow, error) {
	args := []string{"new", label, "--window", windowLabel, "--keep-open", "--json"}
	if cwd != "" {
		args = append(args, "-c", cwd)
	}
	if len(command) > 0 {
		args = append(args, "--")
		args = append(args, command...)
	}
	out, err := c.Exec(ctx, nil, c.Bin, args...)
	if err != nil {
		return CreatedWindow{}, err
	}
	var resp struct {
		SessionID      string `json:"session_id"`
		InitialWindows []struct {
			WindowID string   `json:"window_id"`
			BlockIDs []string `json:"block_ids"`
		} `json:"initial_windows"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		return CreatedWindow{}, fmt.Errorf("parse rex new: %w", err)
	}
	res := CreatedWindow{SessionID: resp.SessionID}
	if len(resp.InitialWindows) > 0 {
		res.WindowID = resp.InitialWindows[0].WindowID
		if len(resp.InitialWindows[0].BlockIDs) > 0 {
			res.BlockID = resp.InitialWindows[0].BlockIDs[0]
		}
	}
	return res, nil
}

func (c *Client) ListWindows(ctx context.Context, sessionID string) ([]Window, error) {
	out, err := c.Exec(ctx, nil, c.Bin, "window", "ls", "-s", sessionID, "--json")
	if err != nil {
		return nil, err
	}
	var resp struct {
		Windows []Window `json:"windows"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		return nil, fmt.Errorf("parse rex window ls: %w", err)
	}
	return resp.Windows, nil
}

func (c *Client) NewWindow(ctx context.Context, sessionID, label, cwd string, focus bool, command []string) (CreatedWindow, error) {
	args := []string{"window", "new", "-s", sessionID, label, "--keep-open", "--json"}
	if !focus {
		args = append(args, "--focus=false")
	}
	if cwd != "" {
		args = append(args, "-c", cwd)
	}
	if len(command) > 0 {
		args = append(args, "--")
		args = append(args, command...)
	}
	out, err := c.Exec(ctx, nil, c.Bin, args...)
	if err != nil {
		return CreatedWindow{}, err
	}
	var resp struct {
		WindowID string   `json:"window_id"`
		BlockID  string   `json:"block_id"`
		BlockIDs []string `json:"block_ids"`
		Window   *struct {
			WindowID       string `json:"window_id"`
			FocusedBlockID string `json:"focused_block_id"`
		} `json:"window"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		return CreatedWindow{}, fmt.Errorf("parse rex window new: %w", err)
	}
	res := CreatedWindow{SessionID: sessionID, WindowID: resp.WindowID, BlockID: resp.BlockID}
	if res.WindowID == "" && resp.Window != nil {
		res.WindowID = resp.Window.WindowID
	}
	if res.BlockID == "" && len(resp.BlockIDs) > 0 {
		res.BlockID = resp.BlockIDs[0]
	}
	if res.BlockID == "" && resp.Window != nil {
		res.BlockID = resp.Window.FocusedBlockID
	}
	return res, nil
}

func (c *Client) CloseWindow(ctx context.Context, sessionID, windowID string) error {
	_, err := c.Exec(ctx, nil, c.Bin, "window", "close", "-s", sessionID, windowID)
	return err
}

// SendPrompt types text into a Rex block and presses Enter to submit it.
func (c *Client) SendPrompt(ctx context.Context, sessionID, blockID, text string) error {
	if strings.TrimSpace(text) == "" {
		return errors.New("empty prompt text")
	}
	if _, err := c.Exec(ctx, []byte(text), c.Bin, "send", "-s", sessionID, "-b", blockID); err != nil {
		return err
	}
	_, err := c.Exec(ctx, nil, c.Bin, "send-key", "-s", sessionID, "-b", blockID, "enter")
	return err
}

// Capture returns the trimmed visible screen/scrollback text of one Rex terminal block.
func (c *Client) Capture(ctx context.Context, sessionID, blockID string) (string, error) {
	out, err := c.Exec(ctx, nil, c.Bin, "capture", "-s", sessionID, "-b", blockID, "--trim")
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// dialogMarkers are footer hints a terminal program prints while a dialog or menu holds the keyboard. Text typed
// then goes to the dialog, not to the prompt.
var dialogMarkers = []string{"esc not now", "enter to confirm", "esc to cancel", "enter to select"}

// DialogMarker reports the footer hint that shows a dialog or menu is open in a captured screen, or "". Only the
// last few lines count: the same words further up are conversation text.
func DialogMarker(screen string) string {
	var tail []string
	lines := strings.Split(screen, "\n")
	for i := len(lines) - 1; i >= 0 && len(tail) < 6; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			tail = append(tail, strings.ToLower(line))
		}
	}
	for _, line := range tail {
		for _, marker := range dialogMarkers {
			if strings.Contains(line, marker) {
				return marker
			}
		}
	}
	return ""
}

// ParseProgramStatusEvent extracts an OSC 7501 status change from one `rex events --json` line.
func ParseProgramStatusEvent(line []byte) (*ProgramStatusEvent, bool) {
	var envelope struct {
		Event *struct {
			Type    string `json:"type"`
			Payload struct {
				BlockID string `json:"block_id"`
				Name    string `json:"name"`
				Payload struct {
					Record struct {
						State string `json:"state"`
						Kind  string `json:"kind"`
						App   string `json:"app"`
						Msg   string `json:"msg"`
					} `json:"record"`
				} `json:"payload"`
			} `json:"payload"`
		} `json:"event"`
	}
	if err := json.Unmarshal(line, &envelope); err != nil || envelope.Event == nil {
		return nil, false
	}
	ev := envelope.Event
	if ev.Type != "block_event" || ev.Payload.Name != "program_status_changed" {
		return nil, false
	}
	return &ProgramStatusEvent{
		BlockID: ev.Payload.BlockID,
		State:   ev.Payload.Payload.Record.State,
		Kind:    ev.Payload.Payload.Record.Kind,
		App:     ev.Payload.Payload.Record.App,
		Msg:     ev.Payload.Payload.Record.Msg,
	}, true
}

// StreamProgramStatus runs `rex events -s <sessionID> --json` and emits OSC 7501 updates.
func (c *Client) StreamProgramStatus(ctx context.Context, sessionID string, onEvent func(ProgramStatusEvent)) error {
	cmd := exec.CommandContext(ctx, c.Bin, "events", "-s", sessionID, "--json")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)
	for sc.Scan() {
		if ev, ok := ParseProgramStatusEvent(sc.Bytes()); ok {
			onEvent(*ev)
		}
	}
	scanErr := sc.Err()
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if scanErr != nil {
		return scanErr
	}
	return waitErr
}
