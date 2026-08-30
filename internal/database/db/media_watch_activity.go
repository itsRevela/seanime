package db

import (
	"fmt"
	"seanime/internal/database/models"
	"time"

	"gorm.io/gorm/clause"
)

// UpsertMediaWatchActivity records that the given media was played or had its progress updated through Seanime.
// The AniList media ID is used as the primary key, so each media has a single row that is bumped on every activity.
func (db *Database) UpsertMediaWatchActivity(mediaId int, episodeNumber int) error {
	if mediaId <= 0 {
		return fmt.Errorf("db: cannot record watch activity for invalid media id %d", mediaId)
	}

	err := db.gormdb.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "id"}},
		DoUpdates: clause.AssignmentColumns([]string{"episode_number", "last_watched_at", "updated_at"}),
	}).Create(&models.MediaWatchActivity{
		BaseModel: models.BaseModel{
			ID: uint(mediaId),
		},
		EpisodeNumber: episodeNumber,
		LastWatchedAt: time.Now(),
	}).Error
	if err != nil {
		return fmt.Errorf("db: failed to record watch activity for media %d: %w", mediaId, err)
	}

	return nil
}

// GetMediaWatchActivities returns every recorded media watch activity.
// It always returns a non-nil slice so the API serializes an empty list rather than null.
func (db *Database) GetMediaWatchActivities() ([]*models.MediaWatchActivity, error) {
	res := make([]*models.MediaWatchActivity, 0)
	err := db.gormdb.Find(&res).Error
	if err != nil {
		return nil, fmt.Errorf("db: failed to get watch activities: %w", err)
	}

	return res, nil
}
