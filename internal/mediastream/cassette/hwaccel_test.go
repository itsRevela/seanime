package cassette

import (
	"io"
	"testing"

	"github.com/rs/zerolog"
)

func newTestLogger() *zerolog.Logger {
	l := zerolog.New(io.Discard)
	return &l
}

func TestProbeDecodeCapability_DisabledOrEmptyAlwaysSupported(t *testing.T) {
	t.Parallel()

	logger := newTestLogger()
	cases := []string{"", "cpu", "none", "disabled", "CPU", "Disabled"}
	for _, kind := range cases {
		ResetDecodeProbeCache()
		got := ProbeDecodeCapability("ffmpeg", kind, "av1", "", logger)
		if !got {
			t.Errorf("hwaccel=%q: expected true (CPU path always supported), got false", kind)
		}
	}
}

func TestProbeDecodeCapability_NvidiaUnmappedCodecRejected(t *testing.T) {
	t.Parallel()

	logger := newTestLogger()
	ResetDecodeProbeCache()

	// A codec NVDEC has no hardware path for on any GPU should be rejected
	// without invoking ffmpeg. "theora" is one such codec.
	got := ProbeDecodeCapability("ffmpeg", "nvidia", "theora", "", logger)
	if got {
		t.Fatalf("expected false for nvidia+theora (no NVDEC path), got true")
	}
}

func TestProbeDecodeCapability_BackendsWithoutPerCodecDecoderTrusted(t *testing.T) {
	t.Parallel()

	logger := newTestLogger()
	for _, backend := range []string{"vaapi", "videotoolbox", "custom"} {
		ResetDecodeProbeCache()
		got := ProbeDecodeCapability("ffmpeg", backend, "av1", "", logger)
		if !got {
			t.Errorf("hwaccel=%q: expected true (no per-codec probe), got false", backend)
		}
	}
}

func TestProbeDecodeCapability_UnknownBackendTrusted(t *testing.T) {
	t.Parallel()

	logger := newTestLogger()
	ResetDecodeProbeCache()

	got := ProbeDecodeCapability("ffmpeg", "some-future-backend", "h264", "", logger)
	if !got {
		t.Fatalf("expected true for unknown backend (trust runtime), got false")
	}
}

func TestProbeDecodeCapability_CachesResults(t *testing.T) {
	t.Parallel()

	logger := newTestLogger()
	ResetDecodeProbeCache()

	// First call for an unmapped codec caches a false result.
	if got := ProbeDecodeCapability("ffmpeg", "nvidia", "theora", "", logger); got {
		t.Fatalf("expected false, got true")
	}

	if v, ok := decodeProbeCache.Load("nvidia:theora"); !ok {
		t.Fatal("expected cache entry for nvidia:theora")
	} else if v.(bool) {
		t.Fatalf("expected cached false, got true")
	}

	// Repeating the call should return the cached false without re-running.
	if got := ProbeDecodeCapability("/nonexistent/ffmpeg", "nvidia", "theora", "", logger); got {
		t.Fatalf("cached probe should return false even with bad ffmpeg path")
	}
}

func TestProbeDecodeCapability_CodecNormalization(t *testing.T) {
	t.Parallel()

	logger := newTestLogger()
	ResetDecodeProbeCache()

	// Mixed case and whitespace should normalize to the same cache key.
	// Use an unmapped codec so the early-cache path fires (mapped codecs
	// without a sample return true without caching, which is intentional).
	_ = ProbeDecodeCapability("ffmpeg", "  NVIDIA  ", "  THEORA  ", "", logger)
	if _, ok := decodeProbeCache.Load("nvidia:theora"); !ok {
		t.Fatal("expected normalized cache key nvidia:theora")
	}
}

func TestNvCuvidDecoders_KnownMappings(t *testing.T) {
	t.Parallel()

	expected := map[string]string{
		"h264": "h264_cuvid",
		"hevc": "hevc_cuvid",
		"av1":  "av1_cuvid",
		"vp9":  "vp9_cuvid",
	}
	for codec, want := range expected {
		if got := nvCuvidDecoders[codec]; got != want {
			t.Errorf("nvCuvidDecoders[%q] = %q, want %q", codec, got, want)
		}
	}
}
