package mediastream

import (
	"errors"
	"os"
	"path/filepath"
	"seanime/internal/database/models"
	"seanime/internal/events"
	"seanime/internal/mediastream/cassette"
	"seanime/internal/mediastream/videofile"
	"seanime/internal/util/filecache"
	"seanime/internal/videocore"
	"strings"
	"sync"

	"github.com/rs/zerolog"
	"github.com/samber/mo"
)

type (
	Repository struct {
		transcoder          mo.Option[*cassette.Cassette]
		settings            mo.Option[*models.MediastreamSettings]
		playbackManager     *PlaybackManager
		mediaInfoExtractor  *videofile.MediaInfoExtractor
		attachmentExtractor *videofile.AttachmentExtractor
		logger              *zerolog.Logger
		wsEventManager      events.WSEventManagerInterface
		videoCore           *videocore.VideoCore
		fileCacher          *filecache.Cacher
		reqMu               sync.Mutex
		cacheDir            string // where attachments are stored
		transcodeDir        string // where stream segments are stored
	}

	NewRepositoryOptions struct {
		Logger         *zerolog.Logger
		WSEventManager events.WSEventManagerInterface
		VideoCore      *videocore.VideoCore
		FileCacher     *filecache.Cacher
	}
)

func NewRepository(opts *NewRepositoryOptions) *Repository {
	ret := &Repository{
		logger:             opts.Logger,
		settings:           mo.None[*models.MediastreamSettings](),
		transcoder:         mo.None[*cassette.Cassette](),
		wsEventManager:     opts.WSEventManager,
		videoCore:          opts.VideoCore,
		fileCacher:         opts.FileCacher,
		mediaInfoExtractor: videofile.NewMediaInfoExtractor(opts.FileCacher, opts.Logger),
	}
	ret.playbackManager = NewPlaybackManager(ret)

	if opts.VideoCore != nil {
		opts.VideoCore.RegisterEventCallback(func(event videocore.VideoEvent) bool {
			switch e := event.(type) {
			case *videocore.VideoTerminatedEvent:
				if ret.TranscoderIsInitialized() {
					opts.Logger.Debug().Str("clientId", e.GetClientId()).Msg("mediastream: Received VideoTerminatedEvent, killing transcoder")
					ret.ShutdownTranscodeStream(e.GetClientId())
				}
			}
			return true
		})
	}

	return ret
}

func (r *Repository) IsInitialized() bool {
	return r.settings.IsPresent()
}

func (r *Repository) OnCleanup() {

}

func (r *Repository) InitializeModules(settings *models.MediastreamSettings, cacheDir string, transcodeDir string) {
	if settings == nil {
		r.logger.Error().Msg("mediastream: Settings not present")
		return
	}
	// Create the temp directory
	err := os.MkdirAll(transcodeDir, 0755)
	if err != nil {
		r.logger.Error().Err(err).Msg("mediastream: Failed to create transcode directory")
	}

	settings.FfmpegPath = strings.TrimSpace(strings.Trim(settings.FfmpegPath, "\""))
	if settings.FfmpegPath == "" {
		settings.FfmpegPath = "ffmpeg"
	}

	settings.FfprobePath = strings.TrimSpace(strings.Trim(settings.FfprobePath, "\""))
	if settings.FfprobePath == "" {
		settings.FfprobePath = "ffprobe"
	}

	// Set the settings
	r.settings = mo.Some[*models.MediastreamSettings](settings)

	r.cacheDir = cacheDir
	r.transcodeDir = transcodeDir

	// Initialize the attachment extractor now that we have the cache dir.
	r.attachmentExtractor = videofile.NewAttachmentExtractor(cacheDir, r.logger)

	// Initialize the transcoder
	if ok := r.initializeTranscoder(r.settings); ok {
	}

	r.logger.Info().Msg("mediastream: Module initialized")
}

// CacheWasCleared should be called when the cache directory is manually cleared.
func (r *Repository) CacheWasCleared() {
	r.playbackManager.mediaContainers.Clear()
}

func (r *Repository) ClearTranscodeDir() {
	r.reqMu.Lock()
	defer r.reqMu.Unlock()

	r.logger.Trace().Msg("mediastream: Clearing transcode directory")

	// Empty the transcode directory
	if r.transcodeDir != "" {
		files, err := os.ReadDir(r.transcodeDir)
		if err != nil {
			r.logger.Error().Err(err).Msg("mediastream: Failed to read transcode directory")
			return
		}

		for _, file := range files {
			err = os.RemoveAll(filepath.Join(r.transcodeDir, file.Name()))
			if err != nil {
				r.logger.Error().Err(err).Msg("mediastream: Failed to remove file from transcode directory")
			}
		}
	}

	r.logger.Debug().Msg("mediastream: Transcode directory cleared")

	r.playbackManager.mediaContainers.Clear()
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Transcode
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

func (r *Repository) TranscoderIsInitialized() bool {
	return r.IsInitialized() && r.transcoder.IsPresent()
}

func (r *Repository) RequestTranscodeStream(filepath string, clientId string) (ret *MediaContainer, err error) {
	r.reqMu.Lock()
	defer r.reqMu.Unlock()

	r.logger.Debug().Str("filepath", filepath).Msg("mediastream: Transcode stream requested")

	if !r.IsInitialized() {
		return nil, errors.New("module not initialized")
	}

	// If hwaccel is enabled, probe whether the GPU can actually decode the
	// source codec. When it can't, ffmpeg's implicit -hwaccel form silently
	// falls back to CPU decode while still claiming hwaccel, pegging a core
	// at 100% on codecs like AV1 on older Maxwell/Pascal cards, which starves
	// the encoder pipeline and prevents the player from ever getting segments.
	// In that case, redirect to direct play so the client decodes locally.
	settings := r.settings.MustGet()
	if settings.TranscodeEnabled {
		if downgraded, dErr := r.maybeDowngradeToDirect(filepath, settings); dErr == nil && downgraded != nil {
			return downgraded, nil
		}
	}

	// Reinitialize the transcoder for each new transcode request
	if ok := r.initializeTranscoder(r.settings); !ok {
		return nil, errors.New("real-time transcoder not initialized, check your settings")
	}

	ret, err = r.playbackManager.RequestPlayback(filepath, StreamTypeTranscode)

	return
}

// maybeDowngradeToDirect inspects the source codec and, if the configured
// hwaccel backend cannot hardware-decode it, returns a direct-play media
// container instead of letting the transcoder spin up. Returns (nil, nil)
// when hwaccel can handle the codec; in that case the caller should
// proceed with normal transcode setup.
func (r *Repository) maybeDowngradeToDirect(filepath string, settings *models.MediastreamSettings) (*MediaContainer, error) {
	hwAccel := strings.ToLower(strings.TrimSpace(settings.TranscodeHwAccel))
	if hwAccel == "" || hwAccel == "cpu" || hwAccel == "none" || hwAccel == "disabled" {
		return nil, nil
	}

	info, err := r.mediaInfoExtractor.GetInfo(settings.FfprobePath, filepath)
	if err != nil || info == nil || info.Video == nil {
		// Without codec info we can't make the decision; let the transcoder
		// run and surface any failure at that layer.
		return nil, nil
	}

	codec := info.Video.Codec
	if cassette.ProbeDecodeCapability(settings.FfmpegPath, hwAccel, codec, filepath, r.logger) {
		return nil, nil
	}

	r.logger.Warn().
		Str("codec", codec).
		Str("hwaccel", hwAccel).
		Str("filepath", filepath).
		Msg("mediastream: hardware decoder unavailable for source codec, downgrading transcode request to direct play")

	container, err := r.playbackManager.RequestPlayback(filepath, StreamTypeDirect)
	if err != nil {
		return nil, err
	}
	// Tell the client the server made the call and not to fight us with its
	// own codec-capability check (which is unreliable for libmpv-capable
	// codecs the browser reports as "maybe").
	container.ForceStreamType = true
	return container, nil
}

func (r *Repository) RequestPreloadTranscodeStream(filepath string) (err error) {
	r.logger.Debug().Str("filepath", filepath).Msg("mediastream: Transcode stream preloading requested")

	if !r.IsInitialized() {
		return errors.New("module not initialized")
	}

	_, err = r.playbackManager.PreloadPlayback(filepath, StreamTypeTranscode)

	return
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Direct Play
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

func (r *Repository) RequestDirectPlay(filepath string, clientId string) (ret *MediaContainer, err error) {
	r.reqMu.Lock()
	defer r.reqMu.Unlock()

	r.logger.Debug().Str("filepath", filepath).Msg("mediastream: Direct play requested")

	if !r.IsInitialized() {
		return nil, errors.New("module not initialized")
	}

	ret, err = r.playbackManager.RequestPlayback(filepath, StreamTypeDirect)

	return
}

func (r *Repository) RequestPreloadDirectPlay(filepath string) (err error) {
	r.logger.Debug().Str("filepath", filepath).Msg("mediastream: Direct stream preloading requested")

	if !r.IsInitialized() {
		return errors.New("module not initialized")
	}

	_, err = r.playbackManager.PreloadPlayback(filepath, StreamTypeDirect)

	return
}

///////////////////////////////////////////////////////////////////////////////////////////////

func (r *Repository) initializeTranscoder(settings mo.Option[*models.MediastreamSettings]) bool {
	// Destroy the old transcoder if it exists
	if r.transcoder.IsPresent() {
		tc, _ := r.transcoder.Get()
		tc.Destroy()
	}

	r.transcoder = mo.None[*cassette.Cassette]()

	// If the transcoder is not enabled, don't initialize the transcoder
	if !settings.MustGet().TranscodeEnabled {
		return false
	}

	// If the temp directory is not set, don't initialize the transcoder
	if r.transcodeDir == "" {
		r.logger.Error().Msg("mediastream: Transcode directory not set, could not initialize transcoder")
		return false
	}

	opts := &cassette.NewCassetteOptions{
		Logger:                r.logger,
		HwAccelKind:           settings.MustGet().TranscodeHwAccel,
		Preset:                settings.MustGet().TranscodePreset,
		FfmpegPath:            settings.MustGet().FfmpegPath,
		FfprobePath:           settings.MustGet().FfprobePath,
		HwAccelCustomSettings: settings.MustGet().TranscodeHwAccelCustomSettings,
		TempOutDir:            r.transcodeDir,
	}

	tc, err := cassette.New(opts)
	if err != nil {
		r.logger.Error().Err(err).Msg("mediastream: Failed to initialize cassette")
		return false
	}

	r.playbackManager.mediaContainers.Clear()

	r.logger.Info().Msg("mediastream: Cassette module initialized")
	r.transcoder = mo.Some[*cassette.Cassette](tc)

	return true
}
