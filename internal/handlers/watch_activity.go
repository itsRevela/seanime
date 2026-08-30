package handlers

import (
	"github.com/labstack/echo/v4"
)

// HandleGetMediaWatchActivity
//
//	@summary returns the watch activity recorded by Seanime.
//	@desc Each item records the last time a media was played or had its progress updated through Seanime
//	@desc (integrated media players, manual tracking, the built-in player, or the update-progress endpoints).
//	@desc The item ID is the AniList media ID. This is independent of AniList's own timestamps.
//	@route /api/v1/library/watch-activity [GET]
//	@returns []models.MediaWatchActivity
func (h *Handler) HandleGetMediaWatchActivity(c echo.Context) error {
	activities, err := h.App.Database.GetMediaWatchActivities()
	if err != nil {
		return h.RespondWithError(c, err)
	}

	return h.RespondWithData(c, activities)
}
