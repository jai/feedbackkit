package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// WorkItem matches one pending work item returned by `POST /runner/poll`.
type WorkItem struct {
	Chat    string `json:"chat"`
	Message string `json:"message"`
	App     string `json:"app"`
	Login   string `json:"login"`
	Repo    string `json:"repo"`
	Role    string `json:"role"`
	Name    string `json:"name,omitempty"`
	Echo    bool   `json:"echo,omitempty"`
	// First is the chat's first message (a new chat); later ones go to whichever runner started it.
	First bool `json:"first"`
}

// ClaimResponse holds the payload returned by `POST /runner/claim`.
type ClaimResponse struct {
	Chat  string `json:"chat"`
	App   string `json:"app"`
	Login string `json:"login"`
	Repo  string `json:"repo"`
	Role  string `json:"role"`
	Text  string `json:"text"`
	Build string `json:"build,omitempty"`
	Title string `json:"title,omitempty"`
}

// Client speaks FeedbackKit Worker's `/runner/*` HTTP API.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		HTTP:    &http.Client{Timeout: 60 * time.Second},
	}
}

func (c *Client) postJSON(ctx context.Context, route string, body any, out any) (int, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/runner/"+route, bytes.NewReader(raw))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "feedbackkit-rex-runner")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return resp.StatusCode, err
	}
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, fmt.Errorf("worker /runner/%s status %d: %s", route, resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	if out != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, out); err != nil {
			return resp.StatusCode, fmt.Errorf("decode /runner/%s: %w", route, err)
		}
	}
	return resp.StatusCode, nil
}

// Wait long-polls `POST /runner/wait` until a new message arrives or timeout expires.
func (c *Client) Wait(ctx context.Context, since *int, hold time.Duration) (int, bool, error) {
	ms := int(hold.Milliseconds())
	if ms > 25_000 {
		ms = 25_000
	}
	payload := map[string]any{"since": since, "ms": ms}
	var resp struct {
		Seq int `json:"seq"`
	}
	code, err := c.postJSON(ctx, "wait", payload, &resp)
	if code == http.StatusNotFound {
		return 0, false, nil
	}
	if err != nil {
		return 0, true, err
	}
	return resp.Seq, true, nil
}

// Poll fetches pending work items from `POST /runner/poll`.
func (c *Client) Poll(ctx context.Context, online bool, detail string) ([]WorkItem, error) {
	var d *string
	if detail != "" {
		d = &detail
	}
	var resp struct {
		Work []WorkItem `json:"work"`
	}
	_, err := c.postJSON(ctx, "poll", map[string]any{"orca": online, "detail": d}, &resp)
	return resp.Work, err
}

// Claim claims one pending message (returns nil, nil if already claimed or gone).
func (c *Client) Claim(ctx context.Context, item WorkItem) (*ClaimResponse, error) {
	var resp ClaimResponse
	code, err := c.postJSON(ctx, "claim", map[string]any{
		"app":     item.App,
		"login":   item.Login,
		"chat":    item.Chat,
		"message": item.Message,
	}, &resp)
	if code == http.StatusNotFound || code == http.StatusConflict {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// The claim answers the message (text, title, ...), not whose it is: that comes from the work item.
	resp.Chat, resp.App, resp.Login = item.Chat, item.App, item.Login
	if resp.Repo == "" {
		resp.Repo = item.Repo
	}
	if resp.Role == "" {
		resp.Role = item.Role
	}
	return &resp, nil
}

// RexRunSummary is the sanitized run payload pushed to the `/about` live dashboard.
type RexRunSummary struct {
	ChatID      string `json:"chat_id"`
	App         string `json:"app"`
	Agent       string `json:"agent"`
	Status      string `json:"status"`
	UpdatedAtMs int64  `json:"updated_at_ms"`
}

// RexStatusPayload is pushed to `POST /runner/rex-status` for the live `/about` dashboard.
type RexStatusPayload struct {
	SessionName       string          `json:"session_name"`
	SessionActive     bool            `json:"session_active"`
	CoordinatorActive bool            `json:"coordinator_active"`
	CoordinatorState  string          `json:"coordinator_state"`
	InboxPending      int             `json:"inbox_pending"`
	DaemonRunning     bool            `json:"daemon_running"`
	ClaimApps         []string        `json:"claim_apps"`
	Runs              []RexRunSummary `json:"runs"`
}

// PushRexStatus publishes sanitized Rex runner telemetry to `POST /runner/rex-status`.
func (c *Client) PushRexStatus(ctx context.Context, payload RexStatusPayload) error {
	_, err := c.postJSON(ctx, "rex-status", payload, nil)
	return err
}

// RexInspectPane is one live captured Rex pane for authenticated `/about/inspect` drill-down.
type RexInspectPane struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Kind    string `json:"kind"` // coordinator | builder
	Status  string `json:"status"`
	Agent   string `json:"agent,omitempty"`
	App     string `json:"app,omitempty"`
	Capture string `json:"capture"`
}

// RexInspectInboxEvent is one recent inbox event shown in `/about/inspect`.
type RexInspectInboxEvent struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	ChatID    string `json:"chat_id,omitempty"`
	App       string `json:"app,omitempty"`
	Status    string `json:"status,omitempty"`
	Summary   string `json:"summary"`
	CreatedAt string `json:"created_at,omitempty"`
}

// RexInspectPayload is pushed to `POST /runner/rex-inspect`.
type RexInspectPayload struct {
	SessionName string                 `json:"session_name"`
	Panes       []RexInspectPane       `json:"panes"`
	RecentInbox []RexInspectInboxEvent `json:"recent_inbox"`
}

// PushRexInspect publishes live Rex pane captures + recent inbox events to `POST /runner/rex-inspect`.
func (c *Client) PushRexInspect(ctx context.Context, payload RexInspectPayload) error {
	_, err := c.postJSON(ctx, "rex-inspect", payload, nil)
	return err
}

// AgentMessage matches one agent-side message expected by `POST /runner/agent`.
type AgentMessage struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	At   string `json:"at"`
}

// AgentSidePayload matches FeedbackKit Worker's `POST /runner/agent` contract.
type AgentSidePayload struct {
	App       string         `json:"app"`
	Login     string         `json:"login"`
	Chat      string         `json:"chat"`
	Messages  []AgentMessage `json:"messages"`
	IsWorking bool           `json:"isWorking"`
	Activity  *string        `json:"activity"`
	Thread    any            `json:"thread"`
	// Shipped is the Worker's `shipped` object (worker/src/shipped.ts); omitted until the chat shipped something.
	Shipped json.RawMessage `json:"shipped,omitempty"`
	// Asks says the agent's last word is a question for the sender: the chat's row shows Needs you until they answer.
	Asks bool `json:"asks,omitempty"`
}

// PostAgent pushes the agent's messages and working status to `POST /runner/agent`.
func (c *Client) PostAgent(ctx context.Context, payload AgentSidePayload) error {
	if payload.Messages == nil {
		payload.Messages = []AgentMessage{}
	}
	code, err := c.postJSON(ctx, "agent", payload, nil)
	if code == http.StatusNotFound {
		return nil
	}
	return err
}

// Result reports delivered/failed back to `POST /runner/result`.
func (c *Client) Result(ctx context.Context, item WorkItem, status, detail string) error {
	var d *string
	if detail != "" {
		d = &detail
	}
	code, err := c.postJSON(ctx, "result", map[string]any{
		"app":     item.App,
		"login":   item.Login,
		"chat":    item.Chat,
		"message": item.Message,
		"status":  status,
		"detail":  d,
	}, nil)
	if code == http.StatusNotFound || code == http.StatusConflict {
		return nil
	}
	return err
}
