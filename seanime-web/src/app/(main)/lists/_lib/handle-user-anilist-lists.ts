import { AL_AnimeCollection_MediaListCollection_Lists } from "@/api/generated/types"
import { useGetRawAnimeCollection, useGetRawAnimeCollectionTags } from "@/api/hooks/anilist.hooks"
import { useGetLibraryCollection } from "@/api/hooks/anime_collection.hooks"
import { useGetRawAnilistMangaCollection, useGetRawAnilistMangaCollectionTags } from "@/api/hooks/manga.hooks"
import { useGetMangaDownloadsList } from "@/api/hooks/manga_download.hooks"
import { useGetMediaWatchActivity } from "@/api/hooks/watch_activity.hooks"
import { useServerStatus } from "@/app/(main)/_hooks/use-server-status"
import { CollectionParams, CollectionType, DEFAULT_COLLECTION_PARAMS, filterEntriesByTitle, filterMyListsEntries } from "@/lib/helpers/filtering"
import { buildWatchActivityMap } from "@/lib/helpers/my-lists-filtering"
import { atomWithImmer } from "jotai-immer"
import { useAtom } from "jotai/react"
import React from "react"
import { useDebounce } from "use-debounce"

export const MYLISTS_DEFAULT_PARAMS: CollectionParams<"anime"> | CollectionParams<"manga"> = {
    ...DEFAULT_COLLECTION_PARAMS,
    sorting: "SCORE_DESC",
    unreadOnly: false,
    continueWatchingOnly: false,
}

export const __myListsSearch_paramsAtom = atomWithImmer<CollectionParams<"anime"> | CollectionParams<"manga">>(MYLISTS_DEFAULT_PARAMS)

export const __myListsSearch_paramsInputAtom = atomWithImmer<CollectionParams<"anime"> | CollectionParams<"manga">>(MYLISTS_DEFAULT_PARAMS)

export const __myLists_selectedTypeAtom = atomWithImmer<"anime" | "manga" | "stats">("anime")

/**
 * Params that can be pinned by a caller instead of using the My Lists page atoms
 * (used by the "My Lists" home item, whose options are persisted server-side).
 */
export type MyListsParamsOverride = {
    // Only sortings valid for both anime and manga lists
    sorting?: CollectionParams<"anime">["sorting"] & CollectionParams<"manga">["sorting"]
    localOnly?: boolean
}

export function useHandleUserAnilistLists(debouncedSearchInput: string, type?: "anime" | "manga", paramsOverride?: MyListsParamsOverride) {

    const serverStatus = useServerStatus()
    const [selectedType, setSelectedType] = useAtom(__myLists_selectedTypeAtom)
    const { data: animeData } = useGetRawAnimeCollection()
    const { data: mangaData } = useGetRawAnilistMangaCollection()
    const { data: animeTagMap } = useGetRawAnimeCollectionTags()
    const { data: mangaTagMap } = useGetRawAnilistMangaCollectionTags()

    const activeType = type ?? selectedType

    // Local content ("Local only" filter): library files for anime, downloaded chapters for manga
    const { data: libraryCollection } = useGetLibraryCollection()
    const { data: mangaDownloadsList } = useGetMangaDownloadsList({
        enabled: !!serverStatus?.settings?.library?.enableManga && activeType === "manga",
    })
    // Watch activity recorded by Seanime ("Recently watched" sorting)
    const { data: watchActivities } = useGetMediaWatchActivity()

    const localMediaIds = React.useMemo(() => {
        if (activeType === "anime") {
            if (!libraryCollection) return undefined
            const entries = libraryCollection.lists?.flatMap(list => list.entries ?? []) ?? []
            return new Set(entries.filter(entry => !!entry.libraryData).map(entry => entry.mediaId))
        }
        if (!mangaDownloadsList) return undefined
        return new Set(mangaDownloadsList.map(item => item.mediaId))
    }, [activeType, libraryCollection, mangaDownloadsList])

    const watchActivity = React.useMemo(() => buildWatchActivityMap(watchActivities), [watchActivities])

    const data = React.useMemo(() => {
        if (type) {
            return type === "anime" ? animeData : mangaData
        }
        return selectedType === "anime" ? animeData : mangaData
    }, [selectedType, animeData, mangaData, type])

    const lists = React.useMemo(() => data?.MediaListCollection?.lists, [data])
    const mediaTagMap = React.useMemo(() => {
        if (type) {
            return type === "anime" ? animeTagMap : mangaTagMap
        }
        return selectedType === "anime" ? animeTagMap : mangaTagMap
    }, [animeTagMap, mangaTagMap, selectedType, type])

    const [params, _setParams] = useAtom(__myListsSearch_paramsAtom)
    const [debouncedParams] = useDebounce(params, 500)

    // With an override (home item), the params are pinned to the defaults + the persisted item options,
    // otherwise they come from the My Lists page atoms
    const effectiveParams = React.useMemo<CollectionParams<"anime"> | CollectionParams<"manga">>(() => {
        if (!paramsOverride) return params
        return {
            ...MYLISTS_DEFAULT_PARAMS,
            ...(paramsOverride.sorting ? { sorting: paramsOverride.sorting } : {}),
            ...(paramsOverride.localOnly !== undefined ? { localOnly: paramsOverride.localOnly } : {}),
        }
    }, [params, !!paramsOverride, paramsOverride?.sorting, paramsOverride?.localOnly])

    React.useLayoutEffect(() => {
        if (selectedType === "manga" && !serverStatus?.settings?.library?.enableManga) {
            setSelectedType("anime")
        }
    }, [serverStatus?.settings?.library?.enableManga])

    React.useLayoutEffect(() => {
        // A pinned caller doesn't own the page atoms, so it must not reset them
        if (paramsOverride) return
        _setParams(MYLISTS_DEFAULT_PARAMS)
    }, [selectedType])

    const _filteredLists: AL_AnimeCollection_MediaListCollection_Lists[] = React.useMemo(() => {
        return lists?.map(obj => {
            if (!obj) return undefined
            const arr = filterMyListsEntries(
                activeType as CollectionType,
                obj?.entries,
                effectiveParams,
                serverStatus?.settings?.anilist?.enableAdultContent,
                mediaTagMap,
                localMediaIds,
                watchActivity,
            )
            return {
                name: obj?.name,
                isCustomList: obj?.isCustomList,
                status: obj?.status,
                entries: arr,
            }
        }).filter(Boolean) ?? []
    }, [
        lists,
        debouncedParams,
        paramsOverride?.sorting,
        paramsOverride?.localOnly,
        mediaTagMap,
        activeType,
        serverStatus?.settings?.anilist?.enableAdultContent,
        localMediaIds,
        watchActivity,
    ])

    const filteredLists: AL_AnimeCollection_MediaListCollection_Lists[] = React.useMemo(() => {
        return _filteredLists?.map(obj => {
            if (!obj) return undefined
            const arr = filterEntriesByTitle(obj?.entries, debouncedSearchInput)
            return {
                name: obj?.name,
                isCustomList: obj?.isCustomList,
                status: obj?.status,
                entries: arr,
            }
        })?.filter(Boolean) ?? []
    }, [_filteredLists, debouncedSearchInput])

    const customLists = React.useMemo(() => {
        return filteredLists?.filter(obj => obj?.isCustomList) ?? []
    }, [filteredLists])

    return {
        currentList: React.useMemo(() => filteredLists?.find(l => l?.status === "CURRENT"), [filteredLists]),
        repeatingList: React.useMemo(() => filteredLists?.find(l => l?.status === "REPEATING"), [filteredLists]),
        planningList: React.useMemo(() => filteredLists?.find(l => l?.status === "PLANNING"), [filteredLists]),
        pausedList: React.useMemo(() => filteredLists?.find(l => l?.status === "PAUSED"), [filteredLists]),
        completedList: React.useMemo(() => filteredLists?.find(l => l?.status === "COMPLETED"), [filteredLists]),
        droppedList: React.useMemo(() => filteredLists?.find(l => l?.status === "DROPPED"), [filteredLists]),
        customLists,
    }
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
