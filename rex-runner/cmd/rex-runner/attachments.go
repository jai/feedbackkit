package main

import (
	"context"

	"github.com/jai/feedbackkit/rex-runner/internal/media"
	"github.com/jai/feedbackkit/rex-runner/internal/worker"
)

// claimedAttachments saves a claimed message's screenshots and videos under the runs folder and answers what the
// coordinator is told of them: each file's path, and how to look at a video. Empty for a message with none. The
// claim's answer used to be read for its words alone, so a builder was handed neither a screenshot nor a video.
func claimedAttachments(ctx context.Context, runsDir string, wc *worker.Client, item worker.WorkItem, claimed *worker.ClaimResponse) string {
	if claimed == nil {
		return ""
	}
	saved := media.Save(media.Folder(runsDir, claimed.Chat), item.Message, claimed.Images, claimed.Videos,
		func(index int) ([]byte, error) { return wc.Media(ctx, item, index) })
	return saved.Note()
}
