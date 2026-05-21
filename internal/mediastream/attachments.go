package mediastream

import (
	"errors"
	"net/url"
	"path/filepath"
	"seanime/internal/events"
	"seanime/internal/mediastream/videofile"
	"time"

	"github.com/labstack/echo/v4"
)

// attachmentWaitTimeout caps how long a subtitle / font request waits for
// background extraction before giving up. Large enough to cover the worst
// real-world MKV walks we've measured on shfs FUSE (~200s) while still being
// shorter than typical HTTP client timeouts.
const attachmentWaitTimeout = 4 * time.Minute

func (r *Repository) ServeEchoExtractedSubtitles(c echo.Context) error {

	if !r.IsInitialized() {
		r.wsEventManager.SendEvent(events.MediastreamShutdownStream, "Module not initialized")
		return errors.New("module not initialized")
	}

	if !r.TranscoderIsInitialized() {
		r.wsEventManager.SendEvent(events.MediastreamShutdownStream, "Transcoder not initialized")
		return errors.New("transcoder not initialized")
	}

	// Get the parameter group
	subFilePath := c.Param("*")

	// Get current media
	mediaContainer, found := r.playbackManager.currentMediaContainer.Get()
	if !found {
		return errors.New("no file has been loaded")
	}

	retPath := videofile.GetFileSubsCacheDir(r.cacheDir, mediaContainer.Hash)

	if retPath == "" {
		return errors.New("could not find subtitles")
	}

	if r.attachmentExtractor != nil {
		if err := r.attachmentExtractor.WaitForCompletion(c.Request().Context(), mediaContainer.Hash, attachmentWaitTimeout); err != nil {
			r.logger.Warn().Err(err).Str("hash", mediaContainer.Hash).Msg("mediastream: subtitle wait failed, attempting to serve anyway")
		}
	}

	r.logger.Trace().Msgf("mediastream: Serving subtitles from %s", retPath)

	return c.File(filepath.Join(retPath, subFilePath))
}

func (r *Repository) ServeEchoExtractedAttachments(c echo.Context) error {
	if !r.IsInitialized() {
		r.wsEventManager.SendEvent(events.MediastreamShutdownStream, "Module not initialized")
		return errors.New("module not initialized")
	}

	if !r.TranscoderIsInitialized() {
		r.wsEventManager.SendEvent(events.MediastreamShutdownStream, "Transcoder not initialized")
		return errors.New("transcoder not initialized")
	}

	// Get the parameter group
	subFilePath := c.Param("*")

	// Get current media
	mediaContainer, found := r.playbackManager.currentMediaContainer.Get()
	if !found {
		return errors.New("no file has been loaded")
	}

	retPath := videofile.GetFileAttCacheDir(r.cacheDir, mediaContainer.Hash)

	if retPath == "" {
		return errors.New("could not find attachments")
	}

	if r.attachmentExtractor != nil {
		if err := r.attachmentExtractor.WaitForCompletion(c.Request().Context(), mediaContainer.Hash, attachmentWaitTimeout); err != nil {
			r.logger.Warn().Err(err).Str("hash", mediaContainer.Hash).Msg("mediastream: attachment wait failed, attempting to serve anyway")
		}
	}

	subFilePath, _ = url.PathUnescape(subFilePath)

	return c.File(filepath.Join(retPath, subFilePath))
}
