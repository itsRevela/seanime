package updater

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// Update announcements are disabled in this fork (updateAnnouncementsDisabled):
// even when the release feed serves a newer version than the running one,
// GetLatestUpdate must never report an available update, on any channel.
func TestUpdater_GetLatestUpdateDisabledInFork(t *testing.T) {
	fixture := newUpdaterTestFixture(t)

	// Running version far older than fixture.release
	u := fixture.newUpdater("2.0.2", nil)
	// update channel is "github"
	update, err := u.GetLatestUpdate()
	require.NoError(t, err)
	require.Nil(t, update, "fork must never announce an update")

	u.UpdateChannel = "seanime"
	update, err = u.GetLatestUpdate()
	require.NoError(t, err)
	require.Nil(t, update, "fork must never announce an update on the seanime channel either")
}

func TestUpdater_GetLatestUpdateSameVersion(t *testing.T) {
	fixture := newUpdaterTestFixture(t)
	u := fixture.newUpdater(fixture.release.Version, nil)
	u.UpdateChannel = "seanime"

	update, err := u.GetLatestUpdate()
	require.NoError(t, err)
	require.Nil(t, update)
}
