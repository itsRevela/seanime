package cassette

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"seanime/internal/mediastream/videofile"
	"strings"
	"sync"
	"time"

	"github.com/goccy/go-json"
	"github.com/rs/zerolog"
)

// HwAccelOptions are configuration knobs for hardware acceleration
type HwAccelOptions struct {
	Kind           string
	Preset         string
	CustomSettings string // JSON-encoded HwAccelProfile for "custom" kind.
}

// BuildHwAccelProfile returns a profile for the requested hardware backend
func BuildHwAccelProfile(opts HwAccelOptions, ffmpegPath string, logger *zerolog.Logger) HwAccelProfile {
	name := opts.Kind
	if name == "" || name == "cpu" || name == "none" {
		name = "disabled"
	}

	// Handle custom JSON profile.
	var custom HwAccelProfile
	if name == "custom" {
		if opts.CustomSettings == "" {
			logger.Warn().Msg("cassette: custom hwaccel selected but no settings provided, falling back to CPU")
			name = "disabled"
		} else if err := json.Unmarshal([]byte(opts.CustomSettings), &custom); err != nil {
			logger.Error().Err(err).Msg("cassette: failed to parse custom hwaccel settings, falling back to CPU")
			name = "disabled"
		} else {
			custom.Name = "custom"
		}
	}

	// probe for the best encoder
	if name == "auto" {
		name = probeHardwareEncoder(ffmpegPath, logger)
	}

	logger.Debug().Str("backend", name).Msg("cassette: hardware acceleration resolved")

	defaultDevice := "/dev/dri/renderD128"
	if runtime.GOOS == "windows" {
		defaultDevice = "auto"
	}

	preset := opts.Preset
	if preset == "" {
		preset = "fast"
	}

	switch name {
	case "disabled":
		return cpuProfile(preset)
	case "vaapi":
		return vaApiProfile(defaultDevice)
	case "qsv", "intel":
		return qsvProfile(defaultDevice, preset)
	case "nvidia":
		return nvidiaProfile(preset)
	case "videotoolbox":
		return videotoolboxProfile()
	case "custom":
		return custom
	default:
		logger.Warn().Str("name", name).Msg("cassette: unknown hwaccel, falling back to CPU")
		return cpuProfile(preset)
	}
}

// hardware probing

// probeHardwareEncoder tests encoders and returns the best backend
func probeHardwareEncoder(ffmpegPath string, logger *zerolog.Logger) string {
	if ffmpegPath == "" {
		ffmpegPath = "ffmpeg"
	}

	type candidate struct {
		name    string
		encoder string
	}

	candidates := []candidate{
		{"nvidia", "h264_nvenc"},
		{"qsv", "h264_qsv"},
		{"vaapi", "h264_vaapi"},
	}
	if runtime.GOOS == "darwin" {
		candidates = append(candidates, candidate{"videotoolbox", "h264_videotoolbox"})
	}

	for _, c := range candidates {
		if testEncoder(ffmpegPath, c.encoder) {
			logger.Info().
				Str("encoder", c.encoder).
				Str("backend", c.name).
				Msg("cassette: hardware encoder probe succeeded")
			return c.name
		}
		logger.Trace().Str("encoder", c.encoder).Msg("cassette: hardware encoder probe failed")
	}

	logger.Info().Msg("cassette: no hardware encoder available, using CPU")
	return "disabled"
}

// TestEncoder attempts a minimal encode to verify if it works
func testEncoder(ffmpegPath, encoder string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Generate 1 frame of black video and encode it with the candidate
	// encoder. If this succeeds, the encoder is functional.
	cmd := exec.CommandContext(ctx, ffmpegPath,
		"-f", "lavfi",
		"-i", "color=black:s=64x64:d=0.04",
		"-c:v", encoder,
		"-frames:v", "1",
		"-f", "null", "-",
	)
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run() == nil
}

// profile constructors

func cpuProfile(preset string) HwAccelProfile {
	return HwAccelProfile{
		Name:        "disabled",
		DecodeFlags: []string{},
		EncodeFlags: []string{
			"-c:v", "libx264",
			"-preset", preset,
			"-profile:v", "high", // ?
			"-tune", "animation", // ?
			// "-tune", "fastdecode,zerolatency", // ?
			"-sc_threshold", "0",
			"-pix_fmt", "yuv420p",
		},
		ScaleFilter:   "scale=%d:%d",
		NoScaleFilter: "format=yuv420p",
		ForcedIDR:     true,
	}
}

func vaApiProfile(device string) HwAccelProfile {
	return HwAccelProfile{
		Name: "vaapi",
		DecodeFlags: []string{
			"-hwaccel", "vaapi",
			"-hwaccel_device", GetEnvOr("SEANIME_TRANSCODER_VAAPI_RENDERER", device),
			"-hwaccel_output_format", "vaapi",
		},
		EncodeFlags: []string{
			"-c:v", "h264_vaapi",
			"-profile:v", "high", // ?
		},
		ScaleFilter:   "format=nv12|vaapi,hwupload,scale_vaapi=%d:%d:format=nv12",
		NoScaleFilter: "format=nv12|vaapi,hwupload",
		ForcedIDR:     true,
	}
}

func qsvProfile(device, preset string) HwAccelProfile {
	return HwAccelProfile{
		Name: "qsv",
		DecodeFlags: []string{
			"-hwaccel", "qsv",
			"-qsv_device", GetEnvOr("SEANIME_TRANSCODER_QSV_RENDERER", device),
			"-hwaccel_output_format", "qsv",
		},
		EncodeFlags: []string{
			"-c:v", "h264_qsv",
			"-preset", preset,
			"-profile:v", "high", // ?
			"-async_depth", "1", // ? reduce latency
			"-look_ahead", "0", // ?
			"-bf", "3", // ?
		},
		ScaleFilter:   "format=nv12|qsv,hwupload,scale_qsv=%d:%d:format=nv12",
		NoScaleFilter: "format=nv12|qsv,hwupload",
		ForcedIDR:     true,
	}
}

func nvidiaProfile(preset string) HwAccelProfile {
	// map to nvenc presets
	switch preset {
	case "ultrafast":
		preset = "p1"
	case "superfast", "veryfast":
		preset = "p2"
	case "faster", "fast":
		preset = "p3"
	case "medium":
		preset = "p4"
	case "slow", "slower":
		preset = "p6"
	case "veryslow", "placebo":
		preset = "p7"
	}
	return HwAccelProfile{
		Name: "nvidia",
		DecodeFlags: []string{
			"-hwaccel", "cuda",
			"-hwaccel_output_format", "cuda",
		},
		EncodeFlags: []string{
			"-c:v", "h264_nvenc",
			"-preset", preset,
			"-profile:v", "high", // ?
			"-rc:v", "vbr", // ?
			"-bf", "0", // ?
			"-spatial-aq", "1", // ?
			"-temporal-aq", "1", // ?
			"-rc-lookahead", "0", // ?
			"-delay", "0",
			"-no-scenecut", "1",
		},
		ScaleFilter:   "format=nv12|cuda,hwupload,scale_cuda=%d:%d:format=nv12",
		NoScaleFilter: "format=nv12|cuda,hwupload",
		ForcedIDR:     true,
	}
}

func videotoolboxProfile() HwAccelProfile {
	return HwAccelProfile{
		Name: "videotoolbox",
		DecodeFlags: []string{
			"-hwaccel", "videotoolbox",
		},
		EncodeFlags: []string{
			"-c:v", "h264_videotoolbox",
			// "-realtime", "true",
			// "-prio_speed", "true",
			"-profile:v", "main",
		},
		ScaleFilter:   "scale=%d:%d",
		NoScaleFilter: "format=yuv420p",
		ForcedIDR:     true,
	}
}

// runtime fallback and adjustments

// BuildVideoFilter generates the scale filter string
func BuildVideoFilter(hw *HwAccelProfile, video *videofile.Video, width, height int32) string {
	noScale := false
	if video.Width == uint32(width) && video.Height == uint32(height) {
		noScale = true
	}

	lower := strings.ToLower(video.PixFmt)
	is10Bit := strings.Contains(lower, "10le") || strings.Contains(lower, "12le") || strings.Contains(lower, "p010")

	// use the scale filter to convert pixel formats if video is 10bit
	// even if we are not resizing the video
	// h264 encoders (nvenc, qsv, vaapi) typically only accept 8-bit formats (like nv12)
	if is10Bit && hw.Name != "custom" && hw.Name != "disabled" && hw.Name != "videotoolbox" {
		noScale = false
	}

	if hw.Name == "custom" {
		if noScale && hw.NoScaleFilter != "" {
			return hw.NoScaleFilter
		}
		return fmt.Sprintf(hw.ScaleFilter, width, height)
	}

	var filter string
	if noScale && hw.NoScaleFilter != "" {
		filter = hw.NoScaleFilter
	} else {
		filter = fmt.Sprintf(hw.ScaleFilter, width, height)
	}

	// Enable p010 hwupload if the source is 10-bit or 12-bit
	if is10Bit && strings.HasPrefix(filter, "format=nv12|") {
		filter = strings.Replace(filter, "format=nv12|", "format=p010|", 1)
	}

	// Software and Videotoolbox use scale= directly
	if !noScale && (hw.Name == "disabled" || hw.Name == "videotoolbox") {
		return filter
	}

	return filter
}

// FallbackToCPU returns a cpu profile
func FallbackToCPU(preset string) HwAccelProfile {
	return cpuProfile(preset)
}

// DetectHwAccelFailure checks for hardware acceleration failures
func DetectHwAccelFailure(stderr string) bool {
	lower := strings.ToLower(stderr)
	failureSignals := []string{
		"hwaccel", "vaapi", "cuvid", "vdpau", "qsv",
		"cuda", "nvenc", "videotoolbox",
		"no capable devices found",
		"device creation failed",
		"initialization failed",
	}
	if !strings.Contains(lower, "failed") && !strings.Contains(lower, "error") {
		return false
	}
	for _, sig := range failureSignals {
		if strings.Contains(lower, sig) {
			return true
		}
	}
	return false
}

// FormatHwAccelSummary returns a summary of the active profile
func FormatHwAccelSummary(p HwAccelProfile) string {
	if p.Name == "disabled" {
		return "CPU (software encoding)"
	}
	encoder := "unknown"
	for i, f := range p.EncodeFlags {
		if f == "-c:v" && i+1 < len(p.EncodeFlags) {
			encoder = p.EncodeFlags[i+1]
			break
		}
	}
	return fmt.Sprintf("%s (%s)", strings.ToUpper(p.Name), encoder)
}

// decode capability probe

// nvCuvidDecoders maps ffprobe codec_name to NVIDIA CUVID hardware decoder.
// If a codec isn't in the map, NVDEC has no hardware path for it on any GPU.
var nvCuvidDecoders = map[string]string{
	"h264":       "h264_cuvid",
	"hevc":       "hevc_cuvid",
	"vp8":        "vp8_cuvid",
	"vp9":        "vp9_cuvid",
	"av1":        "av1_cuvid",
	"mpeg1video": "mpeg1_cuvid",
	"mpeg2video": "mpeg2_cuvid",
	"mpeg4":      "mpeg4_cuvid",
	"vc1":        "vc1_cuvid",
}

// qsvDecoders maps ffprobe codec_name to Intel Quick Sync Video decoder.
var qsvDecoders = map[string]string{
	"h264":       "h264_qsv",
	"hevc":       "hevc_qsv",
	"vp9":        "vp9_qsv",
	"av1":        "av1_qsv",
	"mpeg2video": "mpeg2_qsv",
	"vc1":        "vc1_qsv",
}

// decodeProbeCache caches probe results so we only pay the ffmpeg invocation
// once per (hwaccel, codec) tuple per process lifetime.
//
// Key: "<hwaccel>:<codec>" e.g. "nvidia:av1"
// Value: bool
var decodeProbeCache sync.Map

// ProbeDecodeCapability returns true if the configured hwaccel backend can
// hardware-decode the given source codec on this host's GPU.
//
// It works by invoking ffmpeg with an explicit hardware-codec decoder
// (e.g. -c:v av1_cuvid) on the actual source file and reading one frame.
// If the GPU's NVDEC/QSV unit doesn't support the codec, ffmpeg fails to
// initialize the decoder and the probe returns false. The implicit
// -hwaccel form (-hwaccel cuda alone) silently falls back to software
// decode, which is exactly what we want to avoid, so this probe is
// deliberately stricter.
//
// Results are cached per process by (hwAccelKind, sourceCodec) so the
// probe runs at most once per codec, not per request.
//
// For backends without a per-codec decoder name (vaapi, videotoolbox,
// custom, disabled), this conservatively returns true and lets ffmpeg
// pick at transcode time.
func ProbeDecodeCapability(ffmpegPath, hwAccelKind, sourceCodec, samplePath string, logger *zerolog.Logger) bool {
	if ffmpegPath == "" {
		ffmpegPath = "ffmpeg"
	}
	hwAccelKind = strings.ToLower(strings.TrimSpace(hwAccelKind))
	sourceCodec = strings.ToLower(strings.TrimSpace(sourceCodec))

	// CPU encoding doesn't depend on a hardware decoder; ffmpeg software-decodes
	// in the worker threads, and the caller already accepted that cost when
	// they picked "cpu" / "disabled".
	if hwAccelKind == "" || hwAccelKind == "cpu" || hwAccelKind == "none" || hwAccelKind == "disabled" {
		return true
	}

	// Resolve "auto" to whatever the encoder probe picks, since we need a
	// concrete backend name to look up the right decoder.
	if hwAccelKind == "auto" {
		hwAccelKind = probeHardwareEncoder(ffmpegPath, logger)
		if hwAccelKind == "disabled" {
			return true
		}
	}

	cacheKey := hwAccelKind + ":" + sourceCodec
	if v, ok := decodeProbeCache.Load(cacheKey); ok {
		return v.(bool)
	}

	var decoder string
	switch hwAccelKind {
	case "nvidia":
		decoder = nvCuvidDecoders[sourceCodec]
	case "qsv", "intel":
		decoder = qsvDecoders[sourceCodec]
	case "vaapi", "videotoolbox", "custom":
		// These backends don't expose per-codec decoder names that we can
		// probe in isolation; trust the runtime and skip the probe.
		decodeProbeCache.Store(cacheKey, true)
		return true
	default:
		// Unknown backend; assume the runtime will handle it correctly.
		decodeProbeCache.Store(cacheKey, true)
		return true
	}

	if decoder == "" {
		// We know this backend, but it has no hardware path for this codec
		// on any GPU/iGPU in its product line. Treat as unsupported without
		// even invoking ffmpeg.
		logger.Warn().
			Str("codec", sourceCodec).
			Str("hwaccel", hwAccelKind).
			Msg("cassette: no hardware decoder mapped for source codec, will not use hwaccel")
		decodeProbeCache.Store(cacheKey, false)
		return false
	}

	if samplePath == "" {
		// Can't probe without a sample. Assume support and let the runtime
		// surface failures. We deliberately don't cache this so a later
		// request with a sample can correct the answer.
		return true
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, ffmpegPath,
		"-hide_banner", "-loglevel", "error",
		"-c:v", decoder,
		"-i", samplePath,
		"-frames:v", "1",
		"-f", "null", "-",
	)
	stderr := &strings.Builder{}
	cmd.Stderr = stderr

	err := cmd.Run()
	ok := err == nil

	stderrSnippet := stderr.String()
	if len(stderrSnippet) > 240 {
		stderrSnippet = stderrSnippet[:240]
	}

	logger.Info().
		Bool("ok", ok).
		Str("codec", sourceCodec).
		Str("hwaccel", hwAccelKind).
		Str("decoder", decoder).
		Str("stderr", stderrSnippet).
		Msg("cassette: probed hardware decoder")

	decodeProbeCache.Store(cacheKey, ok)
	return ok
}

// ResetDecodeProbeCache clears the in-memory cache of decode capability
// probes. Useful when ffmpeg or hwaccel settings change at runtime.
func ResetDecodeProbeCache() {
	decodeProbeCache.Range(func(k, _ any) bool {
		decodeProbeCache.Delete(k)
		return true
	})
}
