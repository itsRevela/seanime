package anilist

import (
	"fmt"
	"seanime/internal/hook"
	"sort"

	"github.com/goccy/go-json"
	"github.com/rs/zerolog"
)

func ListMissedSequels(
	client AnilistClient,
	animeCollectionWithRelations *AnimeCollectionWithRelations,
	logger *zerolog.Logger,
	token string,
) (ret []*BaseAnime, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()

	variables := map[string]interface{}{}
	variables["page"] = 1
	variables["perPage"] = 50

	ids := make(map[int]struct{})
	for _, list := range animeCollectionWithRelations.GetMediaListCollection().GetLists() {
		if list.Status == nil || !(*list.Status == MediaListStatusCompleted || *list.Status == MediaListStatusRepeating || *list.Status == MediaListStatusPaused) || list.Entries == nil {
			continue
		}
		for _, entry := range list.Entries {
			if _, ok := ids[entry.GetMedia().GetID()]; !ok {
				edges := entry.GetMedia().GetRelations().GetEdges()
				var sequel *BaseAnime
				for _, edge := range edges {
					if edge.GetRelationType() != nil && *edge.GetRelationType() == MediaRelationSequel {
						sequel = edge.GetNode()
						break
					}
				}

				if sequel == nil {
					continue
				}

				// Check if sequel is already in the list
				_, found := animeCollectionWithRelations.FindAnime(sequel.GetID())
				if found {
					continue
				}

				if *sequel.GetStatus() == MediaStatusFinished || *sequel.GetStatus() == MediaStatusReleasing {
					ids[sequel.GetID()] = struct{}{}
				}
			}

		}
	}

	idsSlice := make([]int, 0, len(ids))
	for id := range ids {
		idsSlice = append(idsSlice, id)
	}

	if len(idsSlice) == 0 {
		return []*BaseAnime{}, nil
	}

	if len(idsSlice) > 10 {
		idsSlice = idsSlice[:10]
	}

	variables["ids"] = idsSlice
	variables["inCollection"] = false
	variables["sort"] = MediaSortStartDateDesc

	// Event
	reqEvent := &ListMissedSequelsRequestedEvent{
		AnimeCollectionWithRelations: animeCollectionWithRelations,
		Variables:                    variables,
		List:                         make([]*BaseAnime, 0),
		Query:                        SearchBaseAnimeByIdsDocument,
	}
	err = hook.GlobalHookManager.OnListMissedSequelsRequested().Trigger(reqEvent)
	if err != nil {
		return nil, err
	}

	// If the hook prevented the default behavior, return the data
	if reqEvent.DefaultPrevented {
		return reqEvent.List, nil
	}

	requestBody, err := json.Marshal(map[string]interface{}{
		"query":     reqEvent.Query,
		"variables": reqEvent.Variables,
	})
	if err != nil {
		return nil, err
	}

	data, err := client.CustomQuery(requestBody, logger, token)
	if err != nil {
		return nil, err
	}

	m, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	var searchRes *SearchBaseAnimeByIds
	if err := json.Unmarshal(m, &searchRes); err != nil {
		return nil, err
	}

	if searchRes == nil || searchRes.Page == nil || searchRes.Page.Media == nil {
		return nil, fmt.Errorf("no data found")
	}

	// Event
	event := &ListMissedSequelsEvent{
		List: searchRes.Page.Media,
	}
	err = hook.GlobalHookManager.OnListMissedSequels().Trigger(event)
	if err != nil {
		return nil, err
	}

	return event.List, nil
}

func ListAnimeM(
	client AnilistClient,
	Page *int,
	Search *string,
	PerPage *int,
	Sort []*MediaSort,
	Status []*MediaStatus,
	Genres []*string,
	Tags []*string,
	AverageScoreGreater *int,
	Season *MediaSeason,
	SeasonYear *int,
	Format *MediaFormat,
	IsAdult *bool,
	CountryOfOrigin *string,
	logger *zerolog.Logger,
	token string,
) (*ListAnime, error) {

	variables := map[string]interface{}{}

	var jikan *jikanSearchResult
	if Search != nil && *Search != "" {
		jikanPage := 1
		if Page != nil && *Page > 0 {
			jikanPage = *Page
		}
		js, jerr := jikanSearchAnime(*Search, jikanPage, logger)
		switch {
		case jerr != nil:
			if logger != nil {
				logger.Warn().Err(jerr).Msg("anilist: jikan fallback failed; falling back to (broken) anilist search")
			}
		case len(js.MALIDs) == 0:
			zeroBool := false
			pageNum := 1
			if Page != nil {
				pageNum = *Page
			}
			perPageNum := 0
			if PerPage != nil {
				perPageNum = *PerPage
			}
			zero := 0
			one := 1
			return &ListAnime{
				Page: &ListAnime_Page{
					Media: []*BaseAnime{},
					PageInfo: &ListAnime_Page_PageInfo{
						HasNextPage: &zeroBool,
						Total:       &zero,
						PerPage:     &perPageNum,
						CurrentPage: &pageNum,
						LastPage:    &one,
					},
				},
			}, nil
		default:
			jikan = js
		}
	}

	if jikan != nil {
		variables["idMal_in"] = jikan.MALIDs
		variables["page"] = 1
		variables["perPage"] = len(jikan.MALIDs)
	} else {
		if Page != nil {
			variables["page"] = *Page
		}
		if Search != nil {
			variables["search"] = *Search
		}
		if PerPage != nil {
			variables["perPage"] = *PerPage
		}
	}

	if Sort != nil {
		if jikan != nil {
			filtered := make([]*MediaSort, 0, len(Sort))
			for _, s := range Sort {
				if s == nil || *s == MediaSortSearchMatch {
					continue
				}
				filtered = append(filtered, s)
			}
			if len(filtered) > 0 {
				variables["sort"] = filtered
			}
		} else {
			variables["sort"] = Sort
		}
	}
	if Status != nil {
		variables["status"] = Status
	}
	if Genres != nil {
		variables["genres"] = Genres
	}
	if Tags != nil {
		variables["tags"] = Tags
	}
	if AverageScoreGreater != nil {
		variables["averageScore_greater"] = *AverageScoreGreater
	}
	if Season != nil {
		variables["season"] = *Season
	}
	if SeasonYear != nil {
		variables["seasonYear"] = *SeasonYear
	}
	if Format != nil {
		variables["format"] = *Format
	}
	if IsAdult != nil {
		variables["isAdult"] = *IsAdult
	}
	if CountryOfOrigin != nil {
		variables["countryOfOrigin"] = *CountryOfOrigin
	}

	query := ListAnimeDocument
	if jikan != nil {
		query = listAnimeByMalIdsDocument
	}

	requestBody, err := json.Marshal(map[string]interface{}{
		"query":     query,
		"variables": variables,
	})
	if err != nil {
		return nil, err
	}

	data, err := client.CustomQuery(requestBody, logger, token)
	if err != nil {
		return nil, err
	}

	var listMediaF ListAnime
	m, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(m, &listMediaF); err != nil {
		return nil, err
	}

	if jikan != nil && listMediaF.Page != nil {
		if len(listMediaF.Page.Media) > 1 {
			rank := make(map[int]int, len(jikan.MALIDs))
			for i, id := range jikan.MALIDs {
				rank[id] = i
			}
			sort.SliceStable(listMediaF.Page.Media, func(i, j int) bool {
				mi, mj := listMediaF.Page.Media[i], listMediaF.Page.Media[j]
				if mi == nil || mi.IDMal == nil {
					return false
				}
				if mj == nil || mj.IDMal == nil {
					return true
				}
				ri, oki := rank[*mi.IDMal]
				rj, okj := rank[*mj.IDMal]
				if !oki {
					ri = len(jikan.MALIDs)
				}
				if !okj {
					rj = len(jikan.MALIDs)
				}
				return ri < rj
			})
		}

		if listMediaF.Page.PageInfo == nil {
			listMediaF.Page.PageInfo = &ListAnime_Page_PageInfo{}
		}
		hasNext := jikan.HasNextPage
		currentPage := jikan.CurrentPage
		if currentPage == 0 && Page != nil {
			currentPage = *Page
		}
		lastPage := jikan.LastPage
		if lastPage == 0 {
			lastPage = currentPage
		}
		total := jikan.Total
		perPage := len(jikan.MALIDs)
		if PerPage != nil && *PerPage > perPage {
			perPage = *PerPage
		}
		listMediaF.Page.PageInfo.HasNextPage = &hasNext
		listMediaF.Page.PageInfo.CurrentPage = &currentPage
		listMediaF.Page.PageInfo.LastPage = &lastPage
		listMediaF.Page.PageInfo.Total = &total
		listMediaF.Page.PageInfo.PerPage = &perPage
	}

	return &listMediaF, nil
}

func ListMangaM(
	client AnilistClient,
	Page *int,
	Search *string,
	PerPage *int,
	Sort []*MediaSort,
	Status []*MediaStatus,
	Genres []*string,
	Tags []*string,
	AverageScoreGreater *int,
	Year *int,
	Format *MediaFormat,
	CountryOfOrigin *string,
	IsAdult *bool,
	logger *zerolog.Logger,
	token string,
) (*ListManga, error) {

	variables := map[string]interface{}{}
	if Page != nil {
		variables["page"] = *Page
	}
	if Search != nil {
		variables["search"] = *Search
	}
	if PerPage != nil {
		variables["perPage"] = *PerPage
	}
	if Sort != nil {
		variables["sort"] = Sort
	}
	if Status != nil {
		variables["status"] = Status
	}
	if Genres != nil {
		variables["genres"] = Genres
	}
	if Tags != nil {
		variables["tags"] = Tags
	}
	if AverageScoreGreater != nil {
		variables["averageScore_greater"] = *AverageScoreGreater * 10
	}
	if Year != nil {
		variables["startDate_greater"] = new(fmt.Sprintf("%d0000", *Year))
		variables["startDate_lesser"] = new(fmt.Sprintf("%d0000", *Year+1))
	}
	if Format != nil {
		variables["format"] = *Format
	}
	if CountryOfOrigin != nil {
		variables["countryOfOrigin"] = *CountryOfOrigin
	}
	if IsAdult != nil {
		variables["isAdult"] = *IsAdult
	}

	requestBody, err := json.Marshal(map[string]interface{}{
		"query":     ListMangaDocument,
		"variables": variables,
	})
	if err != nil {
		return nil, err
	}

	data, err := client.CustomQuery(requestBody, logger, token)
	if err != nil {
		return nil, err
	}

	var listMediaF ListManga
	m, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(m, &listMediaF); err != nil {
		return nil, err
	}

	return &listMediaF, nil
}

func ListRecentAiringAnimeM(
	client AnilistClient,
	Page *int,
	Search *string,
	PerPage *int,
	AiringAtGreater *int,
	AiringAtLesser *int,
	NotYetAired *bool,
	Sort []*AiringSort,
	logger *zerolog.Logger,
	token string,
) (*ListRecentAnime, error) {

	variables := map[string]interface{}{}
	if Page != nil {
		variables["page"] = *Page
	}
	if Search != nil {
		variables["search"] = *Search
	}
	if PerPage != nil {
		variables["perPage"] = *PerPage
	}
	if AiringAtGreater != nil {
		variables["airingAt_greater"] = *AiringAtGreater
	}
	if AiringAtLesser != nil {
		variables["airingAt_lesser"] = *AiringAtLesser
	}
	if NotYetAired != nil {
		variables["notYetAired"] = *NotYetAired
	}
	if Sort != nil {
		variables["sort"] = Sort
	} else {
		variables["sort"] = []*AiringSort{new(AiringSortTimeDesc)}
	}

	requestBody, err := json.Marshal(map[string]interface{}{
		"query":     ListRecentAiringAnimeQuery,
		"variables": variables,
	})
	if err != nil {
		return nil, err
	}

	data, err := client.CustomQuery(requestBody, logger, token)
	if err != nil {
		return nil, err
	}

	var listMediaF ListRecentAnime
	m, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(m, &listMediaF); err != nil {
		return nil, err
	}

	return &listMediaF, nil
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

func ListAnimeCacheKey(
	Page *int,
	Search *string,
	PerPage *int,
	Sort []*MediaSort,
	Status []*MediaStatus,
	Genres []*string,
	Tags []*string,
	AverageScoreGreater *int,
	Season *MediaSeason,
	SeasonYear *int,
	Format *MediaFormat,
	IsAdult *bool,
	CountryOfOrigin *string,
) string {

	key := "ListAnime"
	if Page != nil {
		key += fmt.Sprintf("_%d", *Page)
	}
	if Search != nil {
		key += fmt.Sprintf("_%s", *Search)
	}
	if PerPage != nil {
		key += fmt.Sprintf("_%d", *PerPage)
	}
	if Sort != nil {
		key += fmt.Sprintf("_%v", Sort)
	}
	if Status != nil {
		key += fmt.Sprintf("_%v", Status)
	}
	if Genres != nil {
		key += fmt.Sprintf("_%v", Genres)
	}
	if Tags != nil {
		key += fmt.Sprintf("_%v", Tags)
	}
	if AverageScoreGreater != nil {
		key += fmt.Sprintf("_%d", *AverageScoreGreater)
	}
	if Season != nil {
		key += fmt.Sprintf("_%s", *Season)
	}
	if SeasonYear != nil {
		key += fmt.Sprintf("_%d", *SeasonYear)
	}
	if Format != nil {
		key += fmt.Sprintf("_%s", *Format)
	}
	if IsAdult != nil {
		key += fmt.Sprintf("_%t", *IsAdult)
	}
	if CountryOfOrigin != nil {
		key += fmt.Sprintf("_%s", *CountryOfOrigin)
	}
	return key

}
func ListMangaCacheKey(
	Page *int,
	Search *string,
	PerPage *int,
	Sort []*MediaSort,
	Status []*MediaStatus,
	Genres []*string,
	Tags []*string,
	AverageScoreGreater *int,
	Season *MediaSeason,
	SeasonYear *int,
	Format *MediaFormat,
	CountryOfOrigin *string,
	IsAdult *bool,
) string {

	key := "ListManga"
	if Page != nil {
		key += fmt.Sprintf("_%d", *Page)
	}
	if Search != nil {
		key += fmt.Sprintf("_%s", *Search)
	}
	if PerPage != nil {
		key += fmt.Sprintf("_%d", *PerPage)
	}
	if Sort != nil {
		key += fmt.Sprintf("_%v", Sort)
	}
	if Status != nil {
		key += fmt.Sprintf("_%v", Status)
	}
	if Genres != nil {
		key += fmt.Sprintf("_%v", Genres)
	}
	if Tags != nil {
		key += fmt.Sprintf("_%v", Tags)
	}
	if AverageScoreGreater != nil {
		key += fmt.Sprintf("_%d", *AverageScoreGreater)
	}
	if Season != nil {
		key += fmt.Sprintf("_%s", *Season)
	}
	if SeasonYear != nil {
		key += fmt.Sprintf("_%d", *SeasonYear)
	}
	if Format != nil {
		key += fmt.Sprintf("_%s", *Format)
	}
	if CountryOfOrigin != nil {
		key += fmt.Sprintf("_%s", *CountryOfOrigin)
	}
	if IsAdult != nil {
		key += fmt.Sprintf("_%t", *IsAdult)
	}

	return key

}

const ListRecentAiringAnimeQuery = `query ListRecentAnime ($page: Int, $perPage: Int, $airingAt_greater: Int, $airingAt_lesser: Int, $sort: [AiringSort], $notYetAired: Boolean = false) {
	Page(page: $page, perPage: $perPage) {
		pageInfo {
			hasNextPage
			total
			perPage
			currentPage
			lastPage
		}
		airingSchedules(notYetAired: $notYetAired, sort: $sort, airingAt_greater: $airingAt_greater, airingAt_lesser: $airingAt_lesser) {
			id
			airingAt
			episode
			timeUntilAiring
			media {
				... baseAnime
			}
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
