package cassette

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"seanime/internal/mediastream/videofile"
	"seanime/internal/util"
	"strconv"
	"strings"
	"sync"

	"github.com/rs/zerolog"
)

// Session represents a per-file transcode session
type Session struct {
	// ready is decremented once keyframes load
	ready sync.WaitGroup
	// err is set if initialization fails
	err error

	Path      string
	Out       string
	Keyframes *KeyframeIndex
	Info      *videofile.MediaInfo
	Ladder    []QualityLadderEntry

	// videos and audios are created lazily
	videosMu sync.Mutex
	videos   map[Quality]*Pipeline

	audiosMu sync.Mutex
	audios   map[int32]*Pipeline

	settings *Settings
	governor *Governor
	logger   *zerolog.Logger
}

// NewSession creates a transcode session and starts keyframe extraction
func NewSession(
	path, hash string,
	info *videofile.MediaInfo,
	settings *Settings,
	governor *Governor,
	logger *zerolog.Logger,
) *Session {
	s := &Session{
		Path:     path,
		Out:      filepath.Join(settings.StreamDir, hash),
		videos:   make(map[Quality]*Pipeline),
		audios:   make(map[int32]*Pipeline),
		Info:     info,
		Ladder:   BuildQualityLadder(info),
		settings: settings,
		governor: governor,
		logger:   logger,
	}

	s.ready.Add(1)
	go func() {
		defer s.ready.Done()
		s.Keyframes = getOrExtractKeyframes(path, hash, settings, logger)
	}()

	if len(s.Ladder) > 0 {
		logger.Debug().
			Int("tiers", len(s.Ladder)).
			Bool("canTransmux", s.Ladder[0].OriginalCanTransmux).
			Msg("cassette: quality ladder built")
	}

	return s
}

// WaitReady blocks until the keyframe index is ready
func (s *Session) WaitReady() error {
	s.ready.Wait()
	return s.err
}

// master / index / segment accessors

// GetMaster returns the hls master playlist
func (s *Session) GetMaster(token string) string {
	return GenerateMasterPlaylist(s.Info, s.Ladder, token)
}

// GetVideoIndex returns the hls variant playlist for a quality
func (s *Session) GetVideoIndex(q Quality, token string) (string, error) {
	p := s.getVideoPipeline(q)
	return p.GetIndex(token)
}

// GetVideoSegment returns the path to a video segment, blocking until ready
func (s *Session) GetVideoSegment(ctx context.Context, q Quality, seg int32) (string, error) {
	// The timeout is bounded by the pipeline constraints, but the request controls early cancellation.
	type result struct {
		path string
		err  error
	}
	ch := make(chan result, 1)

	go func() {
		p := s.getVideoPipeline(q)
		path, err := p.GetSegment(ctx, seg)
		ch <- result{path, err}
	}()

	select {
	case r := <-ch:
		return r.path, r.err
	case <-ctx.Done():
		return "", fmt.Errorf("cassette: context canceled waiting for video segment %d (%s)", seg, q)
	}
}

// GetAudioIndex returns the hls variant playlist for an audio track
func (s *Session) GetAudioIndex(audio int32, token string) (string, error) {
	p := s.getAudioPipeline(audio)
	return p.GetIndex(token)
}

// GetAudioSegment returns the path to an audio segment
func (s *Session) GetAudioSegment(ctx context.Context, audio, seg int32) (string, error) {
	p := s.getAudioPipeline(audio)
	return p.GetSegment(ctx, seg)
}

// video pipeline factory

func (s *Session) getVideoPipeline(q Quality) *Pipeline {
	s.videosMu.Lock()
	defer s.videosMu.Unlock()

	if p, ok := s.videos[q]; ok {
		return p
	}

	s.logger.Trace().Str("file", filepath.Base(s.Path)).Str("quality", string(q)).
		Msg("cassette: creating video pipeline")

	// Check if this quality can transmux.
	canTransmux := false
	if q == Original {
		for _, entry := range s.Ladder {
			if entry.Quality == Original {
				canTransmux = entry.OriginalCanTransmux
				break
			}
		}
	}

	buildArgs := func(segmentTimes string) []string {
		args := []string{"-map", "0:V:0"}

		if canTransmux {
			// no encode, just copy.
			args = append(args, "-c:v", "copy")
			return args
		}

		if q == Original {
			// Needs transcode even for original quality (e.g. HEVC).
			args = append(args, s.settings.HwAccel.EncodeFlags...)

			avgBitrate, maxBitrate := EffectiveBitrate(Original, s.Info.Video.Bitrate)
			if avgBitrate == 0 {
				avgBitrate = 5_000_000
				maxBitrate = 8_000_000
			}

			width := closestEven(int32(s.Info.Video.Width))
			args = append(args,
				"-vf", BuildVideoFilter(&s.settings.HwAccel, s.Info.Video, width, int32(s.Info.Video.Height)),
				"-bufsize", fmt.Sprint(maxBitrate*5),
				"-b:v", fmt.Sprint(avgBitrate),
				"-maxrate", fmt.Sprint(maxBitrate),
			)

			if s.settings.HwAccel.ForcedIDR {
				args = append(args, "-forced-idr", "1")
			}
			args = append(args,
				"-force_key_frames", segmentTimes,
				"-strict", "-2",
			)
			return args
		}

		// Downscale transcode.
		args = append(args, s.settings.HwAccel.EncodeFlags...)

		width := closestEven(int32(
			float64(q.Height()) / float64(s.Info.Video.Height) * float64(s.Info.Video.Width),
		))
		args = append(args,
			"-vf", BuildVideoFilter(&s.settings.HwAccel, s.Info.Video, width, int32(q.Height())),
			// "-vf", fmt.Sprintf(s.settings.HwAccel.ScaleFilter, width, q.Height()),
			"-bufsize", fmt.Sprint(q.MaxBitrate()*5),
			"-b:v", fmt.Sprint(q.AverageBitrate()),
			"-maxrate", fmt.Sprint(q.MaxBitrate()),
		)
		if s.settings.HwAccel.ForcedIDR {
			args = append(args, "-forced-idr", "1")
		}
		args = append(args,
			"-force_key_frames", segmentTimes,
			"-strict", "-2",
		)
		return args
	}

	outFmt := func(eid int) string {
		return filepath.Join(s.Out, fmt.Sprintf("segment-%s-%d-%%d.ts", q, eid))
	}

	label := fmt.Sprintf("video (%s)", q)
	if canTransmux {
		label = "video (original/transmux)"
	}

	p := NewPipeline(PipelineConfig{
		Kind:       VideoKind,
		Label:      label,
		Session:    s,
		Settings:   s.settings,
		Governor:   s.governor,
		Logger:     s.logger,
		BuildArgs:  buildArgs,
		OutPathFmt: outFmt,
	})
	s.videos[q] = p
	return p
}

// audio pipeline factory

// getAudioPipeline creates or retrieves an audio pipeline.
func (s *Session) getAudioPipeline(idx int32) *Pipeline {
	s.audiosMu.Lock()
	defer s.audiosMu.Unlock()

	if p, ok := s.audios[idx]; ok {
		return p
	}

	s.logger.Trace().Str("file", filepath.Base(s.Path)).Int32("audio", idx).
		Msg("cassette: creating audio pipeline")

	// Get source audio info.
	var srcAudio *videofile.Audio
	for i := range s.Info.Audios {
		if int32(s.Info.Audios[i].Index) == idx {
			srcAudio = &s.Info.Audios[i]
			break
		}
	}

	decision := AudioTranscodeDecision{
		Codec:    "aac",
		Bitrate:  "128k",
		Channels: "2",
	}
	if srcAudio != nil {
		decision = DecideAudioTranscode(srcAudio)
	}

	if decision.Copy {
		s.logger.Debug().Int32("audio", idx).Str("codec", "copy").
			Msg("cassette: audio is HLS-compatible, transmuxing (no re-encode)")
	} else {
		s.logger.Debug().Int32("audio", idx).
			Str("codec", decision.Codec).
			Str("bitrate", decision.Bitrate).
			Str("channels", decision.Channels).
			Msg("cassette: audio needs re-encode")
	}

	buildArgs := func(_ string) []string {
		args := []string{
			"-map", fmt.Sprintf("0:a:%d", idx),
			"-c:a", decision.Codec,
		}
		if !decision.Copy {
			args = append(args, "-ac", decision.Channels)
			if decision.Bitrate != "" {
				args = append(args, "-b:a", decision.Bitrate)
			}
		}
		return args
	}

	outFmt := func(eid int) string {
		return filepath.Join(s.Out, fmt.Sprintf("segment-a%d-%d-%%d.ts", idx, eid))
	}

	// Probe the audio stream's last packet PTS and sample rate. When the
	// source audio ends before the video does (common in dual-audio fansub
	// releases where the dub track is truncated mid-episode), runHead will
	// substitute silence past this timestamp instead of looping ffmpeg
	// over a range that has no audio data to produce.
	//
	// The threshold here matters: virtually every file has the last audio
	// packet PTS land 1-2 seconds short of the video duration just because
	// ffprobe reports packet START times and the final packet (or a brief
	// natural silence over the end card) sits at the tail. Triggering
	// padding on every one of those clips real audio off the credits.
	// We only declare a "truncated audio" condition when the gap is large
	// enough that it can't be normal end-of-file alignment.
	const audioTruncationGapSeconds = 5.0
	audioLastPts, srcSampleRate := probeAudioStreamTail(s.settings.FfprobePath, s.Path, idx, s.logger)
	if audioLastPts > 0 && audioLastPts+audioTruncationGapSeconds < float64(s.Info.Duration) {
		s.logger.Info().
			Int32("audio", idx).
			Float64("audioLastPts", audioLastPts).
			Float64("videoDuration", float64(s.Info.Duration)).
			Float64("gap", float64(s.Info.Duration)-audioLastPts).
			Msg("cassette: audio stream ends well before video, silent padding will be used")
	} else {
		// Track is essentially full-length; disable padding so we never
		// risk substituting silence over real audio.
		audioLastPts = 0
	}

	p := NewPipeline(PipelineConfig{
		Kind:               AudioKind,
		Label:              fmt.Sprintf("audio %d", idx),
		Session:            s,
		Settings:           s.settings,
		Governor:           s.governor,
		Logger:             s.logger,
		BuildArgs:          buildArgs,
		OutPathFmt:         outFmt,
		AudioLastPts:       audioLastPts,
		AudioOutputChans:   decision.Channels,
		AudioOutputBitrate: decision.Bitrate,
		AudioOutputRate:    srcSampleRate,
	})
	s.audios[idx] = p
	return p
}

// probeAudioStreamTail returns (last packet PTS in seconds, sample rate Hz)
// for the given audio stream. Either may be 0 if not determinable; callers
// must treat 0 as "no padding". Reads packet headers for the full audio
// stream; typically ~1-2 seconds on a 24-minute file since only headers
// are touched, not decoded samples.
func probeAudioStreamTail(ffprobePath, path string, audioIdx int32, logger *zerolog.Logger) (lastPts float64, sampleRate int) {
	bin := ffprobePath
	if bin == "" {
		bin = "ffprobe"
	}

	// Sample rate via stream info (cheap, headers only).
	srCmd := util.NewCmd(bin,
		"-v", "error",
		"-select_streams", fmt.Sprintf("a:%d", audioIdx),
		"-show_entries", "stream=sample_rate",
		"-of", "csv=p=0",
		path,
	)
	if out, err := srCmd.Output(); err == nil {
		line := strings.TrimSpace(string(out))
		if v, perr := strconv.Atoi(line); perr == nil {
			sampleRate = v
		}
	}

	// Last packet PTS, read full audio stream packet headers and keep the
	// last value. The bundled jellyfin-ffmpeg's ffprobe does not accept
	// -sseof, so we can't tail-only this; the full pass is still fast.
	cmd := util.NewCmd(bin,
		"-v", "error",
		"-select_streams", fmt.Sprintf("a:%d", audioIdx),
		"-show_entries", "packet=pts_time",
		"-of", "csv=p=0",
		path,
	)
	out, err := cmd.Output()
	if err != nil {
		logger.Debug().Err(err).Int32("audio", audioIdx).
			Msg("cassette: audio tail probe failed (proceeding without padding)")
		return 0, sampleRate
	}

	// Find the last parseable pts_time line.
	lines := strings.Split(string(out), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		line = strings.TrimRight(line, ",")
		if line == "" {
			continue
		}
		if v, perr := strconv.ParseFloat(line, 64); perr == nil {
			return v, sampleRate
		}
	}
	return 0, sampleRate
}

// lifecycle

// Kill stops all running encode pipelines
func (s *Session) Kill() {
	s.videosMu.Lock()
	for _, p := range s.videos {
		p.Kill()
	}
	s.videosMu.Unlock()

	s.audiosMu.Lock()
	for _, p := range s.audios {
		p.Kill()
	}
	s.audiosMu.Unlock()
}

// Destroy stops everything and removes output directory
func (s *Session) Destroy() {
	s.logger.Debug().Str("path", s.Path).Msg("cassette: destroying session")
	s.Kill()
	_ = os.RemoveAll(s.Out)
}
