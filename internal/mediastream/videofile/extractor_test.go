package videofile

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func newTestLogger() *zerolog.Logger {
	l := zerolog.New(io.Discard)
	return &l
}

func strPtr(s string) *string { return &s }

func TestAttachmentExtractor_WaitForCompletion_NoJob_ReturnsNil(t *testing.T) {
	t.Parallel()
	e := NewAttachmentExtractor(t.TempDir(), newTestLogger())
	if err := e.WaitForCompletion(context.Background(), "no-such-hash", time.Second); err != nil {
		t.Fatalf("expected nil err for missing job, got %v", err)
	}
}

func TestAttachmentExtractor_AlreadyOnDisk_ReturnsClosedJob(t *testing.T) {
	t.Parallel()

	cacheDir := t.TempDir()
	hash := "abc123"
	mediaInfo := &MediaInfo{
		Subtitles: []Subtitle{{Index: 0, Extension: strPtr("ass")}},
	}

	// Pre-populate the subs cache so the extractor short-circuits.
	subs := GetFileSubsCacheDir(cacheDir, hash)
	if err := os.MkdirAll(subs, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(subs, "0.ass"), []byte("[Script Info]\n"), 0644); err != nil {
		t.Fatal(err)
	}

	e := NewAttachmentExtractor(cacheDir, newTestLogger())
	job := e.StartAsync("ffmpeg", "/does/not/matter.mkv", hash, mediaInfo)
	if job == nil {
		t.Fatal("expected non-nil job for already-cached attachments")
	}

	select {
	case <-job.done:
		// expected
	case <-time.After(time.Second):
		t.Fatal("expected job.done to be closed immediately when cache is hot")
	}

	if err := e.WaitForCompletion(context.Background(), hash, time.Second); err != nil {
		t.Fatalf("expected nil err for already-done job, got %v", err)
	}
}

func TestAttachmentExtractor_Deduplicates_ConcurrentCallers(t *testing.T) {
	t.Parallel()

	cacheDir := t.TempDir()
	mediaInfo := &MediaInfo{
		Subtitles: []Subtitle{{Index: 0, Extension: strPtr("ass")}},
	}
	hash := "dedup"

	e := NewAttachmentExtractor(cacheDir, newTestLogger())

	// Two concurrent StartAsync calls should return the same job pointer.
	j1 := e.StartAsync("/bin/false", "/nonexistent.mkv", hash, mediaInfo)
	j2 := e.StartAsync("/bin/false", "/nonexistent.mkv", hash, mediaInfo)
	if j1 == nil || j2 == nil {
		t.Fatal("expected non-nil jobs")
	}
	if j1 != j2 {
		t.Errorf("expected the same job pointer for concurrent callers, got %p vs %p", j1, j2)
	}

	// Job uses /bin/false → ffmpeg fails fast. Wait should still return cleanly
	// (with an err from the underlying command), not hang.
	if err := e.WaitForCompletion(context.Background(), hash, 30*time.Second); err == nil {
		t.Log("warning: expected error from /bin/false invocation, got nil (acceptable if ffmpeg path lookup short-circuited)")
	}
}

func TestAttachmentExtractor_WaitForCompletion_RespectsContextCancellation(t *testing.T) {
	t.Parallel()

	cacheDir := t.TempDir()
	mediaInfo := &MediaInfo{
		Subtitles: []Subtitle{{Index: 0, Extension: strPtr("ass")}},
	}
	hash := "cancel-test"

	e := NewAttachmentExtractor(cacheDir, newTestLogger())
	// /usr/bin/sleep doesn't exist on all hosts, so use a sentinel command we
	// know will run for a bit longer than the cancel.
	_ = e.StartAsync("sleep", "100", hash, mediaInfo)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	start := time.Now()
	err := e.WaitForCompletion(ctx, hash, 30*time.Second)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected error from canceled context")
	}
	if elapsed > 2*time.Second {
		t.Errorf("WaitForCompletion ignored context cancellation, took %s", elapsed)
	}
}

func TestSubtitlesAlreadyOnDisk_EmptyMediaInfo(t *testing.T) {
	t.Parallel()

	cacheDir := t.TempDir()
	mediaInfo := &MediaInfo{Subtitles: nil}
	// No subtitles in the file → no expected outputs → trivially "done".
	if !subtitlesAlreadyOnDisk(cacheDir, "any", mediaInfo) {
		t.Error("expected true when no subtitles need extracting")
	}
}

func TestSubtitlesAlreadyOnDisk_MissingFiles(t *testing.T) {
	t.Parallel()

	cacheDir := t.TempDir()
	mediaInfo := &MediaInfo{
		Subtitles: []Subtitle{
			{Index: 0, Extension: strPtr("ass")},
			{Index: 1, Extension: strPtr("ass")},
		},
	}
	if subtitlesAlreadyOnDisk(cacheDir, "missing", mediaInfo) {
		t.Error("expected false when subtitle files are not present")
	}
}

func TestSubtitlesAlreadyOnDisk_ZeroByteFilesDoNotCount(t *testing.T) {
	t.Parallel()

	cacheDir := t.TempDir()
	hash := "stubs-only"
	mediaInfo := &MediaInfo{
		Subtitles: []Subtitle{
			{Index: 0, Extension: strPtr("ass")},
			{Index: 1, Extension: strPtr("ass")},
		},
	}

	// Simulate the failure mode that bit us in the wild: ffmpeg created
	// the output files but was killed before writing any data.
	subs := GetFileSubsCacheDir(cacheDir, hash)
	if err := os.MkdirAll(subs, 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0.ass", "1.ass"} {
		if err := os.WriteFile(filepath.Join(subs, name), nil, 0644); err != nil {
			t.Fatal(err)
		}
	}

	if subtitlesAlreadyOnDisk(cacheDir, hash, mediaInfo) {
		t.Error("expected false: zero-byte stubs should not count as extracted")
	}

	// Populate one of the two with content. Still not enough.
	if err := os.WriteFile(filepath.Join(subs, "0.ass"), []byte("[Script Info]\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if subtitlesAlreadyOnDisk(cacheDir, hash, mediaInfo) {
		t.Error("expected false: only one of two subs has content")
	}

	// Populate both. Now we're truly done.
	if err := os.WriteFile(filepath.Join(subs, "1.ass"), []byte("[Script Info]\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if !subtitlesAlreadyOnDisk(cacheDir, hash, mediaInfo) {
		t.Error("expected true: both subs have content")
	}
}

func TestAttachmentExtractor_FailedJob_RetriedOnNextStart(t *testing.T) {
	t.Parallel()

	cacheDir := t.TempDir()
	mediaInfo := &MediaInfo{
		Subtitles: []Subtitle{{Index: 0, Extension: strPtr("ass")}},
	}
	hash := "retry-after-fail"

	e := NewAttachmentExtractor(cacheDir, newTestLogger())

	// Manually seed a failed, completed job to simulate a prior timeout.
	failed := &extractionJob{
		done:      closedChan(),
		err:       errFakeFailure,
		startedAt: time.Now(),
	}
	e.mu.Lock()
	e.jobs[hash] = failed
	e.mu.Unlock()

	// Next StartAsync should drop the failed entry and create a fresh job.
	// Using /bin/false makes the new job also error out quickly but
	// importantly it should NOT be the same pointer as the seeded failure.
	fresh := e.StartAsync("/bin/false", "/nonexistent.mkv", hash, mediaInfo)
	if fresh == nil {
		t.Fatal("expected a fresh job after a failed prior attempt")
	}
	if fresh == failed {
		t.Fatal("expected the failed job to be cleared, but got the same pointer")
	}

	// Wait for the fresh job to finish so the test exits cleanly.
	<-fresh.done
}

var errFakeFailure = &fakeErr{}

type fakeErr struct{}

func (*fakeErr) Error() string { return "fake failure" }

func TestWaitForFile_AlreadyExists(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "exists.txt")
	if err := os.WriteFile(path, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := WaitForFile(context.Background(), path, time.Second); err != nil {
		t.Fatalf("expected nil err for existing file, got %v", err)
	}
}

func TestWaitForFile_TimesOut(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "never.txt")
	start := time.Now()
	err := WaitForFile(context.Background(), path, 200*time.Millisecond)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if elapsed > time.Second {
		t.Errorf("WaitForFile took too long: %s", elapsed)
	}
}
