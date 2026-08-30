import { describe, expect, it } from "vitest"
import {
    buildWatchActivityMap,
    filterEntriesWithLocalContent,
    getEntryLastActivityTime,
    sortEntriesByLastActivity,
    WatchActivityMap,
} from "./my-lists-filtering"

type TestEntry = { media?: { id: number } | null, updatedAt?: number }

const entry = (id: number, updatedAt?: number): TestEntry => ({ media: { id }, updatedAt })

const ids = (entries: TestEntry[]) => entries.map(e => e.media?.id)

describe("my-lists-filtering", () => {

    describe("buildWatchActivityMap", () => {
        it("maps media ids to their last watched timestamp", () => {
            const map = buildWatchActivityMap([
                { id: 1, lastWatchedAt: "2026-08-01T10:00:00Z" },
                { id: 2, lastWatchedAt: "2026-08-02T10:00:00Z" },
            ])
            expect(map).toEqual({ 1: "2026-08-01T10:00:00Z", 2: "2026-08-02T10:00:00Z" })
        })

        it("returns an empty map for missing or empty input", () => {
            expect(buildWatchActivityMap(undefined)).toEqual({})
            expect(buildWatchActivityMap(null)).toEqual({})
            expect(buildWatchActivityMap([])).toEqual({})
        })

        it("ignores items without a timestamp", () => {
            expect(buildWatchActivityMap([{ id: 1 }, { id: 2, lastWatchedAt: "2026-08-02T10:00:00Z" }])).toEqual({ 2: "2026-08-02T10:00:00Z" })
        })
    })

    describe("getEntryLastActivityTime", () => {
        const activity: WatchActivityMap = { 1: "2026-08-10T00:00:00Z" }

        it("prefers Seanime watch activity over AniList updatedAt", () => {
            // AniList updatedAt is more recent, but Seanime activity must win
            const aniListUpdatedAt = Math.floor(new Date("2026-08-20T00:00:00Z").getTime() / 1000)
            expect(getEntryLastActivityTime(entry(1, aniListUpdatedAt), activity)).toBe(new Date("2026-08-10T00:00:00Z").getTime())
        })

        it("falls back to AniList updatedAt (unix seconds) when there is no Seanime activity", () => {
            expect(getEntryLastActivityTime(entry(2, 1_700_000_000), activity)).toBe(1_700_000_000_000)
        })

        it("returns undefined when neither is known", () => {
            expect(getEntryLastActivityTime(entry(3), activity)).toBeUndefined()
            expect(getEntryLastActivityTime(entry(3, 0), activity)).toBeUndefined()
            expect(getEntryLastActivityTime({ media: null }, activity)).toBeUndefined()
        })

        it("ignores unparseable Seanime timestamps and falls back to AniList", () => {
            expect(getEntryLastActivityTime(entry(1, 1_700_000_000), { 1: "not-a-date" })).toBe(1_700_000_000_000)
        })
    })

    describe("filterEntriesWithLocalContent", () => {
        it("keeps only entries whose media id has local content", () => {
            const result = filterEntriesWithLocalContent([entry(1), entry(2), entry(3)], new Set([1, 3]))
            expect(ids(result)).toEqual([1, 3])
        })

        it("returns nothing while local media ids are unknown", () => {
            expect(filterEntriesWithLocalContent([entry(1)], undefined)).toEqual([])
            expect(filterEntriesWithLocalContent([entry(1)], null)).toEqual([])
        })

        it("handles empty inputs and entries without media", () => {
            expect(filterEntriesWithLocalContent([], new Set([1]))).toEqual([])
            expect(filterEntriesWithLocalContent([{ media: null }, {}], new Set([1]))).toEqual([])
        })
    })

    describe("sortEntriesByLastActivity", () => {
        const activity: WatchActivityMap = {
            1: "2026-08-05T00:00:00Z",
            2: "2026-08-25T00:00:00Z",
        }
        const aniListOnly = entry(3, Math.floor(new Date("2026-08-15T00:00:00Z").getTime() / 1000))
        const unknown = entry(4)
        const entries = [entry(1), unknown, aniListOnly, entry(2)]

        it("sorts most recent first in descending order, mixing Seanime and AniList timestamps", () => {
            expect(ids(sortEntriesByLastActivity(entries, activity, "desc"))).toEqual([2, 3, 1, 4])
        })

        it("sorts least recent first in ascending order", () => {
            expect(ids(sortEntriesByLastActivity(entries, activity, "asc"))).toEqual([1, 3, 2, 4])
        })

        it("always places entries without any known activity last", () => {
            const result = sortEntriesByLastActivity([unknown, entry(5), entry(1)], activity, "desc")
            expect(ids(result)).toEqual([1, 4, 5])
        })

        it("does not mutate the input array", () => {
            const input = [entry(1), entry(2)]
            sortEntriesByLastActivity(input, activity, "desc")
            expect(ids(input)).toEqual([1, 2])
        })

        it("works without any watch activity by using AniList timestamps only", () => {
            const result = sortEntriesByLastActivity([entry(1, 100), entry(2, 300), entry(3, 200)], undefined, "desc")
            expect(ids(result)).toEqual([2, 3, 1])
        })
    })
})
