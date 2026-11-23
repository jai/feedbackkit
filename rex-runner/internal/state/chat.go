package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// ChatReply is one agent-side message sent to FeedbackKit Worker (`POST /runner/agent`).
type ChatReply struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	At   string `json:"at"`
}

// ChatRecord persists sender routing metadata and agent reply history for one FeedbackKit chat
// so `rex-runner reply` can post incremental replies back to the user's phone/app.
type ChatRecord struct {
	ChatID   string      `json:"chat_id"`
	App      string      `json:"app"`
	Login    string      `json:"login"`
	Repo     string      `json:"repo,omitempty"`
	Role     string      `json:"role,omitempty"`
	Title    string      `json:"title,omitempty"`
	Messages []ChatReply `json:"messages"`
	// Shipped is the last `shipped` object sent for this chat; every reply resends it, as the Worker replaces the side.
	Shipped json.RawMessage `json:"shipped,omitempty"`
	// Asks is whether the last reply asked the sender a question (`reply --ask`); each reply sets it anew, and a message
	// of the sender's clears it.
	Asks      bool      `json:"asks,omitempty"`
	UpdatedAt time.Time `json:"updated_at"`
}

func chatPath(stateDir, chatID string) string {
	return filepath.Join(stateDir, "chats", chatID+".json")
}

// LoadChat reads `<stateDir>/chats/<chatID>.json`.
func LoadChat(stateDir, chatID string) (ChatRecord, error) {
	var rec ChatRecord
	raw, err := os.ReadFile(chatPath(stateDir, chatID))
	if err != nil {
		return rec, err
	}
	if err := json.Unmarshal(raw, &rec); err != nil {
		return rec, fmt.Errorf("parse chat record %s: %w", chatID, err)
	}
	return rec, nil
}

// SaveChat atomically writes `<stateDir>/chats/<chatID>.json`.
func SaveChat(stateDir string, rec ChatRecord) error {
	rec.UpdatedAt = time.Now().UTC()
	if rec.Messages == nil {
		rec.Messages = []ChatReply{}
	}
	return WriteAtomic(chatPath(stateDir, rec.ChatID), rec)
}
