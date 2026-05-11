package anilist

import (
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/goccy/go-json"
	"github.com/rs/zerolog"
)

const jikanAnimeSearchURL = "https://api.jikan.moe/v4/anime"
const jikanPerPage = 25
const jikanTimeout = 8 * time.Second

type jikanSearchResult struct {
	MALIDs      []int
	Total       int
	CurrentPage int
	LastPage    int
	HasNextPage bool
}

func jikanSearchAnime(query string, page int, logger *zerolog.Logger) (*jikanSearchResult, error) {
	if page <= 0 {
		page = 1
	}
	u := fmt.Sprintf(
		"%s?q=%s&limit=%d&page=%d",
		jikanAnimeSearchURL,
		url.QueryEscape(query),
		jikanPerPage,
		page,
	)

	client := &http.Client{Timeout: jikanTimeout}
	resp, err := client.Get(u)
	if err != nil {
		return nil, fmt.Errorf("jikan request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("jikan returned status %d", resp.StatusCode)
	}

	var parsed struct {
		Data []struct {
			MalID int `json:"mal_id"`
		} `json:"data"`
		Pagination struct {
			LastVisiblePage int  `json:"last_visible_page"`
			HasNextPage     bool `json:"has_next_page"`
			CurrentPage     int  `json:"current_page"`
			Items           struct {
				Count   int `json:"count"`
				Total   int `json:"total"`
				PerPage int `json:"per_page"`
			} `json:"items"`
		} `json:"pagination"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("jikan decode failed: %w", err)
	}

	ids := make([]int, 0, len(parsed.Data))
	for _, m := range parsed.Data {
		if m.MalID > 0 {
			ids = append(ids, m.MalID)
		}
	}

	if logger != nil {
		logger.Debug().
			Str("query", query).
			Int("page", page).
			Int("ids", len(ids)).
			Int("total", parsed.Pagination.Items.Total).
			Msg("jikan: search resolved")
	}

	return &jikanSearchResult{
		MALIDs:      ids,
		Total:       parsed.Pagination.Items.Total,
		CurrentPage: parsed.Pagination.CurrentPage,
		LastPage:    parsed.Pagination.LastVisiblePage,
		HasNextPage: parsed.Pagination.HasNextPage,
	}, nil
}

const listAnimeByMalIdsDocument = `query ListAnimeByMalIds ($page: Int, $perPage: Int, $idMal_in: [Int], $sort: [MediaSort], $status: [MediaStatus], $genres: [String], $tags: [String], $averageScore_greater: Int, $season: MediaSeason, $seasonYear: Int, $format: MediaFormat, $isAdult: Boolean) {
	Page(page: $page, perPage: $perPage) {
		pageInfo {
			hasNextPage
			total
			perPage
			currentPage
			lastPage
		}
		media(type: ANIME, idMal_in: $idMal_in, sort: $sort, status_in: $status, isAdult: $isAdult, format: $format, genre_in: $genres, tag_in: $tags, averageScore_greater: $averageScore_greater, season: $season, seasonYear: $seasonYear, format_not: MUSIC) {
			... baseAnime
		}
	}
}
fragment baseAnime on Media {
	id
	idMal
	siteUrl
	status(version: 2)
	season
	type
	format
	seasonYear
	bannerImage
	episodes
	synonyms
	isAdult
	countryOfOrigin
	meanScore
	description
	genres
	duration
	trailer {
		id
		site
		thumbnail
	}
	title {
		userPreferred
		romaji
		english
		native
	}
	coverImage {
		extraLarge
		large
		medium
		color
	}
	startDate {
		year
		month
		day
	}
	endDate {
		year
		month
		day
	}
	nextAiringEpisode {
		airingAt
		timeUntilAiring
		episode
	}
}
`
