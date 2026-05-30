package cassette

import (
	"testing"

	"seanime/internal/mediastream/videofile"
)

// Regression: with -c:a copy, ffmpeg's MKV demuxer-level seek for the
// audio stream landed on the start of the containing Matroska cluster
// rather than the requested keyframe, leaving every per-head encoder
// (start=0, start=100, start=200, ...) with a different source-time
// offset. The boundary between two heads (e.g. segment 199 -> 200)
// then carried an audible audio jump because the two runs' output
// content was shifted by different amounts relative to the HLS
// playlist's keyframe-derived segment timing. DecideAudioTranscode now
// always asks for AAC re-encoding so accurate_seek's decode-forward
// lands exactly on the requested keyframe and removes the per-head
// drift entirely.
func TestDecideAudioTranscode_AlwaysReEncodes(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		audio    *videofile.Audio
		wantCh   string
		wantRate string
	}{
		{
			name:     "aac stereo source still re-encodes",
			audio:    &videofile.Audio{Codec: "aac", Channels: uint32(2)},
			wantCh:   "2",
			wantRate: "128k",
		},
		{
			name:     "aac 5.1 source preserves channel layout",
			audio:    &videofile.Audio{Codec: "aac", Channels: uint32(6)},
			wantCh:   "6",
			wantRate: "384k",
		},
		{
			name:     "flac stereo source re-encodes to AAC stereo",
			audio:    &videofile.Audio{Codec: "flac", Channels: uint32(2)},
			wantCh:   "2",
			wantRate: "128k",
		},
		{
			name:     "opus 5.1 source re-encodes to AAC 5.1",
			audio:    &videofile.Audio{Codec: "opus", Channels: uint32(6)},
			wantCh:   "6",
			wantRate: "384k",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := DecideAudioTranscode(tc.audio)
			if got.Copy {
				t.Errorf("Copy = true; want false (re-encode required to avoid cluster-start drift)")
			}
			if got.Codec != "aac" {
				t.Errorf("Codec = %q; want %q", got.Codec, "aac")
			}
			if got.Channels != tc.wantCh {
				t.Errorf("Channels = %q; want %q", got.Channels, tc.wantCh)
			}
			if got.Bitrate != tc.wantRate {
				t.Errorf("Bitrate = %q; want %q", got.Bitrate, tc.wantRate)
			}
		})
	}
}
