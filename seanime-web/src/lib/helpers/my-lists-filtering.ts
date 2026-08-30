import sortBy from "lodash/sortBy"

/**
 * Minimal shape of an AniList media list entry needed by the "My Lists" helpers.
 * Both anime and manga collection entries satisfy it.
 */
export type MyListsEntryLike = {
    media?: { id: number } | null
    /** AniList `MediaList.updatedAt` (unix seconds) */
    updatedAt?: number
}

/** AniList media ID -> ISO timestamp of the last activity recorded by Seanime. */
export type WatchActivityMap = Record<number, string>

/** Minimal shape of a `Models_MediaWatchActivity` item returned by the server. */
export type WatchActivityItemLike = {
    /** AniList media ID */
    id: number
    lastWatchedAt?: string
}

/**
 * Builds a media ID -> timestamp lookup from the watch activity returned by the server.
 * Items without a timestamp are ignored.
 */
export function buildWatchActivityMap(activities: WatchActivityItemLike[] | null | undefined): WatchActivityMap {
    if (!activities?.length) return {}
    return activities.reduce<WatchActivityMap>((map, activity) => {
        if (!activity.lastWatchedAt) return map
        return { ...map, [activity.id]: activity.lastWatchedAt }
    }, {})
}

/**
 * Returns the epoch milliseconds of the entry's last activity.
 * Seanime's own watch activity wins; AniList's `updatedAt` is only used as a fallback.
 * Returns undefined when neither is known.
 */
export function getEntryLastActivityTime(entry: MyListsEntryLike, watchActivity: WatchActivityMap | null | undefined): number | undefined {
    const mediaId = entry.media?.id
    const localActivity = typeof mediaId === "number" ? watchActivity?.[mediaId] : undefined
    if (localActivity) {
        const time = new Date(localActivity).getTime()
        if (!Number.isNaN(time)) return time
    }

    if (typeof entry.updatedAt === "number" && entry.updatedAt > 0) {
        return entry.updatedAt * 1000
    }

    return undefined
}

/**
 * Keeps only the entries whose media has local content (library files, downloaded chapters...).
 * Returns an empty array while the local media IDs are not known yet.
 */
export function filterEntriesWithLocalContent<T extends MyListsEntryLike>(
    entries: T[],
    localMediaIds: ReadonlySet<number> | null | undefined,
): T[] {
    if (!localMediaIds) return []
    return entries.filter(entry => typeof entry.media?.id === "number" && localMediaIds.has(entry.media.id))
}

/**
 * Sorts entries by their last activity (see `getEntryLastActivityTime`).
 * Entries without any known activity are always placed last, keeping their relative order.
 */
export function sortEntriesByLastActivity<T extends MyListsEntryLike>(
    entries: T[],
    watchActivity: WatchActivityMap | null | undefined,
    order: "asc" | "desc",
): T[] {
    const withActivity = entries.filter(entry => getEntryLastActivityTime(entry, watchActivity) !== undefined)
    const withoutActivity = entries.filter(entry => getEntryLastActivityTime(entry, watchActivity) === undefined)

    const sorted = sortBy(withActivity, entry => {
        const time = getEntryLastActivityTime(entry, watchActivity) ?? 0
        return order === "desc" ? -time : time
    })

    return [...sorted, ...withoutActivity]
}
