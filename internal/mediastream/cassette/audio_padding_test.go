package cassette

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// Pipeline.SetAudioPadding / Pipeline.audioPadding round-trip and concurrent
// reads/writes. The async probe in session.go writes once after creation
// while runHead may be reading concurrently from multiple goroutines, so we
// need both the write to be visible and the reads to not race.
func TestPipeline_AudioPaddingConcurrent(t *testing.T) {
	t.Parallel()

	p := &Pipeline{}

	const writers = 4
	const readers = 16
	const iterations = 5_000

	var wg sync.WaitGroup
	wg.Add(writers + readers)

	for w := 0; w < writers; w++ {
		w := w
		go func() {
			defer wg.Done()
			for i := 0; i < iterations; i++ {
				p.SetAudioPadding(float64(w*iterations+i), 48000+w)
			}
		}()
	}

	for r := 0; r < readers; r++ {
		go func() {
			defer wg.Done()
			for i := 0; i < iterations; i++ {
				_, _ = p.audioPadding()
			}
		}()
	}

	wg.Wait()

	// After all writers finish, one of their final values must be visible.
	lastPts, rate := p.audioPadding()
	if lastPts < 0 || rate <= 0 {
		t.Fatalf("audioPadding() = (%v, %v); expected positive values after writers ran", lastPts, rate)
	}
}

// Regression: SetAudioPadding must accept (0, 0) so the "track is
// essentially full-length, but probe ran" path can publish a zeroed entry
// without poisoning runHead. runHead must treat lastPts==0 as
// "padding disabled" regardless of the sample rate value.
func TestPipeline_AudioPaddingZeroDisablesPadding(t *testing.T) {
	t.Parallel()

	p := &Pipeline{}
	p.SetAudioPadding(0, 48000)

	lastPts, rate := p.audioPadding()
	if lastPts != 0 {
		t.Errorf("lastPts = %v; want 0 (padding disabled)", lastPts)
	}
	if rate != 48000 {
		t.Errorf("rate = %d; want 48000 (sample rate published)", rate)
	}
}

// Disk cache round-trip: a probe result written by saveAudioPadCache must
// be readable by loadAudioPadCache and produce an identical entry. This is
// the path that lets subsequent opens of the same file skip the probe.
func TestAudioPadCache_RoundTrip(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := audioPadCachePath(dir, 1)

	want := audioPadCacheEntry{LastPts: 1420.567, SampleRate: 48000}
	if err := saveAudioPadCache(path, want); err != nil {
		t.Fatalf("saveAudioPadCache: %v", err)
	}

	got, ok := loadAudioPadCache(path)
	if !ok {
		t.Fatal("loadAudioPadCache: returned hit=false after a successful save")
	}
	if got != want {
		t.Errorf("loadAudioPadCache: got %+v; want %+v", got, want)
	}
}

// loadAudioPadCache must return hit=false (not crash, not return junk
// values) on every failure mode: missing file, unreadable directory entry,
// and corrupt JSON. These all need to fall through to the live probe path
// rather than poisoning the pipeline with garbage values.
func TestAudioPadCache_MissOnFailureModes(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()

	t.Run("missing file", func(t *testing.T) {
		_, ok := loadAudioPadCache(filepath.Join(dir, "nope.json"))
		if ok {
			t.Error("hit=true for non-existent file")
		}
	})

	t.Run("corrupt JSON", func(t *testing.T) {
		path := filepath.Join(dir, "corrupt.json")
		if err := os.WriteFile(path, []byte("{not valid json"), 0o644); err != nil {
			t.Fatal(err)
		}
		_, ok := loadAudioPadCache(path)
		if ok {
			t.Error("hit=true for corrupt JSON")
		}
	})

	t.Run("directory in the way", func(t *testing.T) {
		path := filepath.Join(dir, "isdir.json")
		if err := os.Mkdir(path, 0o755); err != nil {
			t.Fatal(err)
		}
		_, ok := loadAudioPadCache(path)
		if ok {
			t.Error("hit=true when path is a directory")
		}
	})
}

// audioPadCachePath must produce stable paths so subsequent sessions for
// the same hash + audio index find the same file. Changing the naming
// scheme is a cache-invalidation event; this test makes that visible.
func TestAudioPadCachePath_Stable(t *testing.T) {
	t.Parallel()

	got := audioPadCachePath("/data/cache/transcode/streams/abc123", 2)
	want := filepath.Join("/data/cache/transcode/streams/abc123", "audio_2_pad.json")
	if got != want {
		t.Errorf("audioPadCachePath = %q; want %q", got, want)
	}
}

// Schema canary: if someone renames a JSON field on audioPadCacheEntry
// without a migration, all pre-existing on-disk caches silently fall back
// to the live probe (correctness preserved, but the perf win goes away).
// Pin the on-disk shape so the rename forces a deliberate decision.
func TestAudioPadCache_JSONSchema(t *testing.T) {
	t.Parallel()

	entry := audioPadCacheEntry{LastPts: 1.5, SampleRate: 48000}
	data, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	want := `{"lastPts":1.5,"sampleRate":48000}`
	if got != want {
		t.Errorf("json shape changed:\n  got:  %s\n  want: %s", got, want)
	}
}
