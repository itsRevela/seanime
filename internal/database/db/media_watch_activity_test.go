package db

import (
	"seanime/internal/util"
	"testing"
	"time"
)

func newWatchActivityTestDatabase(t *testing.T) *Database {
	t.Helper()
	database, err := NewDatabase(t.TempDir(), "watch_activity_test", util.NewLogger())
	if err != nil {
		t.Fatalf("failed to create test database: %v", err)
	}
	// Close the SQLite file before TempDir cleanup, otherwise Windows refuses to delete it.
	t.Cleanup(func() {
		if sqlDB, err := database.Gorm().DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	return database
}

func TestGetMediaWatchActivities_ReturnsEmptySliceWhenNothingRecorded(t *testing.T) {
	database := newWatchActivityTestDatabase(t)

	activities, err := database.GetMediaWatchActivities()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if activities == nil {
		t.Fatal("expected a non-nil slice so the API serializes an empty list")
	}
	if len(activities) != 0 {
		t.Fatalf("expected no activities, got %d", len(activities))
	}
}

func TestUpsertMediaWatchActivity_RecordsMediaWithEpisodeAndTimestamp(t *testing.T) {
	database := newWatchActivityTestDatabase(t)
	before := time.Now().Add(-time.Second)

	if err := database.UpsertMediaWatchActivity(21, 3); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	activities, err := database.GetMediaWatchActivities()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(activities) != 1 {
		t.Fatalf("expected 1 activity, got %d", len(activities))
	}
	got := activities[0]
	if got.ID != 21 {
		t.Errorf("expected media id 21, got %d", got.ID)
	}
	if got.EpisodeNumber != 3 {
		t.Errorf("expected episode 3, got %d", got.EpisodeNumber)
	}
	if got.LastWatchedAt.Before(before) || got.LastWatchedAt.After(time.Now().Add(time.Second)) {
		t.Errorf("expected lastWatchedAt to be roughly now, got %v", got.LastWatchedAt)
	}
}

func TestUpsertMediaWatchActivity_BumpsExistingRowInsteadOfDuplicating(t *testing.T) {
	database := newWatchActivityTestDatabase(t)

	if err := database.UpsertMediaWatchActivity(21, 3); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	first, err := database.GetMediaWatchActivities()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	firstTimestamp := first[0].LastWatchedAt

	// SQLite stores timestamps with limited precision, so make sure the clock moves on.
	time.Sleep(20 * time.Millisecond)

	if err := database.UpsertMediaWatchActivity(21, 4); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	activities, err := database.GetMediaWatchActivities()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(activities) != 1 {
		t.Fatalf("expected the same media to stay a single row, got %d rows", len(activities))
	}
	if activities[0].EpisodeNumber != 4 {
		t.Errorf("expected episode to be updated to 4, got %d", activities[0].EpisodeNumber)
	}
	if !activities[0].LastWatchedAt.After(firstTimestamp) {
		t.Errorf("expected lastWatchedAt to advance (was %v, now %v)", firstTimestamp, activities[0].LastWatchedAt)
	}
}

func TestUpsertMediaWatchActivity_RejectsInvalidMediaId(t *testing.T) {
	database := newWatchActivityTestDatabase(t)

	if err := database.UpsertMediaWatchActivity(0, 1); err == nil {
		t.Fatal("expected an error for media id 0")
	}

	activities, err := database.GetMediaWatchActivities()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(activities) != 0 {
		t.Fatalf("expected nothing to be recorded, got %d rows", len(activities))
	}
}
