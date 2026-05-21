package videofile

import (
	"context"
	"errors"
	"fmt"
	"os"
	"seanime/internal/util"
	"sync"
	"time"

	"github.com/rs/zerolog"
)

// closedChan returns a channel that is already closed. Used when extraction
// is a no-op (cache hit) so callers can wait on it and immediately proceed.
func closedChan() chan struct{} {
	c := make(chan struct{})
	close(c)
	return c
}

// AttachmentExtractor coordinates background extraction of MKV attachments
// (subtitles + fonts) so that the API request that triggered the extraction
// can return immediately instead of blocking for the 30-200s it takes ffmpeg
// to walk a 1-2 GB file over shfs FUSE. Subtitle / font serving handlers wait
// on the per-hash completion channel before responding.
//
// Deduplicates concurrent requests for the same hash so multiple clients (or
// the same client retrying through a React remount loop) don't stack ffmpeg
// invocations against the same file.
type AttachmentExtractor struct {
	mu       sync.Mutex
	jobs     map[string]*extractionJob
	logger   *zerolog.Logger
	cacheDir string

	// Timeout that bounds an individual ffmpeg extraction process. Outlived
	// the previous synchronous 120s limit because the API request no longer
	// waits, so we can afford to let big files finish.
	extractionTimeout time.Duration
}

type extractionJob struct {
	done chan struct{}
	err  error
	// startedAt lets us age-out finished jobs from the map after a while so
	// memory doesn't grow unbounded across long server uptimes.
	startedAt time.Time
}

func NewAttachmentExtractor(cacheDir string, logger *zerolog.Logger) *AttachmentExtractor {
	return &AttachmentExtractor{
		jobs:              make(map[string]*extractionJob),
		logger:            logger,
		cacheDir:          cacheDir,
		extractionTimeout: 5 * time.Minute,
	}
}

// StartAsync kicks off extraction for hash in a background goroutine, or
// returns the existing job if one is already running. Returns a channel
// that callers can wait on, plus a pointer that can be inspected (after
// the channel closes) for the final error.
//
// Returns nil if subtitles are already on disk and no work is needed.
func (e *AttachmentExtractor) StartAsync(ffmpegPath, path, hash string, mediaInfo *MediaInfo) *extractionJob {
	if mediaInfo == nil {
		return nil
	}

	e.mu.Lock()
	defer e.mu.Unlock()

	// Sweep finished jobs older than 10 minutes so the map doesn't grow.
	for k, j := range e.jobs {
		if e.isDone(j) && time.Since(j.startedAt) > 10*time.Minute {
			delete(e.jobs, k)
		}
	}

	if existing, ok := e.jobs[hash]; ok {
		// Reuse in-flight jobs. Also reuse successful done jobs so the disk
		// check below stays a fast path. But if the previous attempt failed,
		// drop the entry so this caller retries instead of inheriting the
		// stale error for up to 10 minutes.
		if !e.isDone(existing) || existing.err == nil {
			return existing
		}
		delete(e.jobs, hash)
	}

	// Fast path: cache already populated.
	if subtitlesAlreadyOnDisk(e.cacheDir, hash, mediaInfo) {
		j := &extractionJob{done: closedChan(), startedAt: time.Now()}
		e.jobs[hash] = j
		return j
	}

	job := &extractionJob{
		done:      make(chan struct{}),
		startedAt: time.Now(),
	}
	e.jobs[hash] = job

	go func() {
		defer close(job.done)
		ctx, cancel := context.WithTimeout(context.Background(), e.extractionTimeout)
		defer cancel()

		if err := runExtraction(ctx, ffmpegPath, path, hash, mediaInfo, e.cacheDir, e.logger); err != nil {
			job.err = err
			e.logger.Error().
				Err(err).
				Str("hash", hash).
				Msg("videofile: background attachment extraction failed")
			return
		}
		e.logger.Debug().
			Str("hash", hash).
			Dur("elapsed", time.Since(job.startedAt)).
			Msg("videofile: background attachment extraction complete")
	}()

	return job
}

// WaitForCompletion blocks until extraction for hash finishes, the timeout
// expires, or ctx is canceled. Returns nil if extraction completed
// successfully, an error otherwise.
//
// If no job for hash is tracked we assume extraction was never needed and
// return nil so the caller can attempt to serve directly from disk.
func (e *AttachmentExtractor) WaitForCompletion(ctx context.Context, hash string, timeout time.Duration) error {
	e.mu.Lock()
	job, ok := e.jobs[hash]
	e.mu.Unlock()

	if !ok {
		return nil
	}

	if e.isDone(job) {
		return job.err
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case <-job.done:
		return job.err
	case <-timer.C:
		return fmt.Errorf("waiting for attachment extraction timed out after %s", timeout)
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (e *AttachmentExtractor) isDone(j *extractionJob) bool {
	select {
	case <-j.done:
		return true
	default:
		return false
	}
}

// runExtraction is the same logic the old synchronous ExtractAttachment used,
// pulled out so the goroutine in StartAsync can call it directly with its own
// context.
func runExtraction(ctx context.Context, ffmpegPath, path, hash string, mediaInfo *MediaInfo, cacheDir string, logger *zerolog.Logger) error {
	attachmentPath := GetFileAttCacheDir(cacheDir, hash)
	subsPath := GetFileSubsCacheDir(cacheDir, hash)
	if err := os.MkdirAll(attachmentPath, 0755); err != nil {
		return fmt.Errorf("failed to create attachment cache dir: %w", err)
	}
	if err := os.MkdirAll(subsPath, 0755); err != nil {
		return fmt.Errorf("failed to create subs cache dir: %w", err)
	}

	if subtitlesAlreadyOnDisk(cacheDir, hash, mediaInfo) {
		logger.Debug().Str("hash", hash).Msg("videofile: attachments already extracted")
		return nil
	}

	args := []string{
		"-dump_attachment:t", "",
		"-y",
		"-i", path,
	}

	extractedCount := 0
	for _, sub := range mediaInfo.Subtitles {
		if sub.Extension == nil || *sub.Extension == "" {
			logger.Warn().Uint32("index", sub.Index).Msg("videofile: subtitle format not supported, skipping")
			continue
		}
		args = append(args,
			"-map", fmt.Sprintf("0:s:%d", sub.Index),
			"-c:s", "copy",
			fmt.Sprintf("%s/%d.%s", subsPath, sub.Index, *sub.Extension),
		)
		extractedCount++
	}

	if extractedCount == 0 {
		logger.Debug().Str("hash", hash).Msg("videofile: no extractable subtitles found")
		return nil
	}

	cmd := util.NewCmdCtx(ctx, ffmpegPath, args...)
	cmd.Dir = attachmentPath

	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("attachment extraction timed out (%w)", ctx.Err())
		}
		return fmt.Errorf("attachment extraction failed: %w", err)
	}

	logger.Debug().
		Str("hash", hash).
		Int("subtitles", extractedCount).
		Msg("videofile: attachment extraction complete")
	return nil
}

func subtitlesAlreadyOnDisk(cacheDir, hash string, mediaInfo *MediaInfo) bool {
	// Count only entries with non-empty extensions that match what we'd extract.
	expected := 0
	for _, sub := range mediaInfo.Subtitles {
		if sub.Extension == nil || *sub.Extension == "" {
			continue
		}
		expected++
	}
	if expected == 0 {
		// Nothing to extract — there's no reason to walk the file. Treat as done.
		return true
	}
	subsPath := GetFileSubsCacheDir(cacheDir, hash)
	entries, err := os.ReadDir(subsPath)
	if err != nil {
		return false
	}
	return len(entries) >= expected
}

// WaitForFile blocks until path exists or the wait deadline is reached. Used
// by serving handlers to bridge the gap between extraction kickoff and the
// file actually appearing on disk. Returns nil when the file exists.
func WaitForFile(ctx context.Context, path string, timeout time.Duration) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	tick := time.NewTicker(150 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-tick.C:
			if _, err := os.Stat(path); err == nil {
				return nil
			}
		case <-timer.C:
			return errors.New("file did not appear in time")
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
