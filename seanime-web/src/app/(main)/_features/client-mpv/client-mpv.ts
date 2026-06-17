import { useUpdateContinuityWatchHistoryItem } from "@/api/hooks/continuity.hooks"
import {
    usePlaybackCancelManualTracking,
    usePlaybackStartManualTracking,
    usePlaybackSyncCurrentProgress,
} from "@/api/hooks/playback_manager.hooks"
import { useServerHMACAuth, useServerStatus } from "@/app/(main)/_hooks/use-server-status"
import { clientIdAtom } from "@/app/websocket-provider"
import { logger } from "@/lib/helpers/debug"
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai"
import { atomWithStorage } from "jotai/utils"
import React from "react"
import { toast } from "sonner"

const log = logger("CLIENT MPV")

// Runtime "are we inside Denshi?" probe. The build-time __isElectronDesktop__
// constant flips on only when seanime-web is built with SEA_PUBLIC_DESKTOP
// set, which the Docker-served bundle never has. Since Denshi loads its UI
// from the remote seanime server (mainWindow.loadURL("http://server/"))
// for users running Docker, the build-time flag is always false even
// though the renderer IS inside Electron. The preload contextBridge
// exposes `window.__isElectronDesktop__ === true` regardless of build
// flavour, so prefer that when deciding whether Denshi-specific UI
// should render. window.electron.mpv presence is the more precise
// signal for the mpv bridge itself.
function isInsideDenshi(): boolean {
    if (typeof window === "undefined") return false
    return window.__isElectronDesktop__ === true
}

function hasClientMpvBridge(): boolean {
    if (typeof window === "undefined") return false
    return !!window.electron?.mpv
}

// Hook variant of the above so React components can re-render once the
// preload bridge is confirmed. Reads the value lazily through state so
// SSR / static-renders don't crash on the window access.
export function useIsInsideDenshi(): boolean {
    const [v, setV] = React.useState<boolean>(false)
    React.useEffect(() => { setV(isInsideDenshi()) }, [])
    return v
}

export function useHasClientMpvBridge(): boolean {
    const [v, setV] = React.useState<boolean>(false)
    React.useEffect(() => { setV(hasClientMpvBridge()) }, [])
    return v
}

// Detection result cached for the lifetime of the renderer process.
// Denshi's main process caches its own detection too, so this call
// resolves in milliseconds and we don't need a query layer.
export type ClientMpvDetection = {
    found: boolean
    path: string | null
    source: string | null
    error?: string
    // Populated by useClientMpvAvailability once it has run at least once;
    // null while detection is in flight or never been attempted.
    ranAt: number | null
}

const initialDetection: ClientMpvDetection = {
    found: false,
    path: null,
    source: null,
    ranAt: null,
}

export const __clientMpv_detectionAtom = atom<ClientMpvDetection>(initialDetection)

// User-configurable override for the mpv binary path. Persists in
// localStorage so the user only sets it once per device. Empty string =
// rely on auto-detection.
export const __clientMpv_pathOverrideAtom = atomWithStorage<string>("sea-client-mpv-path", "")

// Extra mpv command-line args appended verbatim to every launch. Useful
// for things like --hwdec=auto, --vo=gpu-next, etc. Persists in
// localStorage so per-device tuning survives restarts.
export const __clientMpv_extraArgsAtom = atomWithStorage<string>("sea-client-mpv-extra-args", "")

// Most recent state snapshot pushed by Denshi's mpv:state IPC event.
// null whenever no mpv session is active.
export const __clientMpv_stateAtom = atom<ClientMpvState | null>(null)

// True from the moment we call denshiMpv.launch() until the mpv:exited
// event arrives. Used by the UI to show "Playing in mpv..." instead of
// the inline player.
export const __clientMpv_activeAtom = atom<boolean>(false)

// The mediaId / episode currently being played in mpv. Cleared on exit.
// Phase 2 will use this to attribute progress reports to the right
// AniList entry.
export type ClientMpvSession = {
    mediaId: number
    episodeNumber: number
    filePath: string
    fileTitle: string
    totalDuration: number | null
    startedAt: number
}

export const __clientMpv_sessionAtom = atom<ClientMpvSession | null>(null)

// Hook: probes Denshi for mpv availability on first call. Safe to use
// outside Denshi — returns { found: false } when window.electron.mpv is
// undefined (browser/web shell). Runs once per app lifetime.
export function useClientMpvAvailability(override?: string) {
    const [detection, setDetection] = useAtom(__clientMpv_detectionAtom)
    const storedOverride = useAtomValue(__clientMpv_pathOverrideAtom)
    const effectiveOverride = override ?? storedOverride

    React.useEffect(() => {
        if (!hasClientMpvBridge()) return
        const mpv = window.electron!.mpv!
        let cancelled = false
        mpv.available(effectiveOverride || undefined)
            .then((res) => {
                if (cancelled) return
                setDetection({
                    found: !!res.found,
                    path: res.path ?? null,
                    source: res.source ?? null,
                    error: res.error,
                    ranAt: Date.now(),
                })
                if (res.found) {
                    log.info("Client mpv available at", res.path, `(via ${res.source})`)
                } else if (res.error) {
                    log.warn("Client mpv availability check failed:", res.error)
                } else {
                    log.info("Client mpv not found on this machine")
                }
            })
            .catch((err: unknown) => {
                if (cancelled) return
                const message = err instanceof Error ? err.message : String(err)
                setDetection({
                    found: false,
                    path: null,
                    source: null,
                    error: message,
                    ranAt: Date.now(),
                })
            })
        return () => { cancelled = true }
    }, [effectiveOverride, setDetection])

    return detection
}

// Lower-level helper for callers that just want to know "is the button
// available?" without triggering a fresh detection. Returns true only
// when Denshi reported a real mpv binary.
export function useIsClientMpvReady(): boolean {
    const detection = useAtomValue(__clientMpv_detectionAtom)
    return !!detection.found
}

export type LaunchClientMpvSiblingEpisode = {
    mediaId: number
    episodeNumber: number
    filePath: string
    fileTitle: string
}

export type LaunchClientMpvArgs = {
    mediaId: number
    episodeNumber: number
    filePath: string
    fileTitle: string
    savedPosition?: number
    externalSubtitles?: Array<{ url: string; title?: string; lang?: string }>
    // Sibling episodes to push into mpv's playlist alongside the
    // current one. The caller provides previous + next as a single
    // ordered array; the launcher computes the starting index from
    // whichever entry matches `filePath`. Allows mpv's < / > buttons
    // and OSC next/prev to navigate the surrounding episodes.
    siblingEpisodes?: LaunchClientMpvSiblingEpisode[]
}

// Hook: returns an async function that launches mpv for an episode.
// Builds the seanime file URL (with HMAC token when the server has a
// password configured) and forwards the launch via IPC. On a non-Denshi
// shell or when mpv isn't detected, shows a toast and bails out.
export function useLaunchClientMpv() {
    const serverStatus = useServerStatus()
    const detection = useAtomValue(__clientMpv_detectionAtom)
    const override = useAtomValue(__clientMpv_pathOverrideAtom)
    const extraArgs = useAtomValue(__clientMpv_extraArgsAtom)
    const clientId = useAtomValue(clientIdAtom)
    const setActive = useSetAtom(__clientMpv_activeAtom)
    const setSession = useSetAtom(__clientMpv_sessionAtom)
    const setState = useSetAtom(__clientMpv_stateAtom)

    const { getHMACTokenQueryParam } = useServerHMACAuth()

    return React.useCallback(async (args: LaunchClientMpvArgs) => {
        if (!hasClientMpvBridge()) {
            toast.error("Client mpv is only available in the desktop app")
            return { ok: false, error: "not in Denshi" }
        }
        if (!detection.found) {
            toast.error("mpv binary not found on this machine. Install mpv or set its path in playback settings.")
            return { ok: false, error: "mpv not found" }
        }

        // Helper: build a /mediastream/file URL for a given server path.
        // Each call attaches its own HMAC token (the server scopes tokens
        // per endpoint, not per request, so siblings can share the call
        // but we await each one to keep the code path uniform).
        const buildFileUrl = async (filePath: string): Promise<string> => {
            const encodedPath = encodeURIComponent(filePath)
            let url = `${window.location.origin}/api/v1/mediastream/file?path=${encodedPath}&client=${encodeURIComponent(clientId ?? "")}`
            if (serverStatus?.serverHasPassword) {
                // HMAC tokens are scoped to the endpoint path, not the
                // query string. The "&" symbol tells getHMACTokenQueryParam
                // to prepend with & since we already have ?path=...
                const token = await getHMACTokenQueryParam("/api/v1/mediastream/file", "&")
                url += token
            }
            return url
        }

        const url = await buildFileUrl(args.filePath)
        log.info("Launching mpv with URL", url)

        // Build the sibling playlist (if provided). We place the current
        // episode and all siblings in episodeNumber order so mpv's
        // < / > navigation feels intuitive. playlistStartIndex points
        // at the entry matching args.filePath (the one we passed to
        // mpv on the command line); previous siblings get insert-at 0'd
        // before it, later siblings get appended after.
        type BuiltPlaylistItem = { url: string; mediaId: number; episodeNumber: number; filePath: string; fileTitle: string }
        let playlist: BuiltPlaylistItem[] | undefined
        let playlistStartIndex: number | undefined
        if (args.siblingEpisodes && args.siblingEpisodes.length > 0) {
            const merged = [
                {
                    mediaId: args.mediaId,
                    episodeNumber: args.episodeNumber,
                    filePath: args.filePath,
                    fileTitle: args.fileTitle,
                },
                ...args.siblingEpisodes,
            ]
                .filter((it) => !!it.filePath)
                // Dedupe by filePath in case the caller accidentally
                // included the current episode in siblingEpisodes too.
                .filter((it, idx, arr) => arr.findIndex((other) => other.filePath === it.filePath) === idx)
                .sort((a, b) => a.episodeNumber - b.episodeNumber)

            const built = await Promise.all(merged.map(async (item) => ({
                url: item.filePath === args.filePath ? url : await buildFileUrl(item.filePath),
                mediaId: item.mediaId,
                episodeNumber: item.episodeNumber,
                filePath: item.filePath,
                fileTitle: item.fileTitle,
            })))
            playlist = built
            playlistStartIndex = built.findIndex((it) => it.filePath === args.filePath)
            if (playlistStartIndex < 0) playlistStartIndex = 0
            log.info(`Built mpv playlist with ${built.length} items, starting at index ${playlistStartIndex}`)
        }

        // Optimistically mark active so the UI can update before the IPC
        // round-trip completes. We'll clear it if launch fails below.
        setSession({
            mediaId: args.mediaId,
            episodeNumber: args.episodeNumber,
            filePath: args.filePath,
            fileTitle: args.fileTitle,
            totalDuration: null,
            startedAt: Date.now(),
        })
        setActive(true)
        setState(null)

        const result = await window.electron!.mpv!.launch({
            url,
            title: args.fileTitle,
            savedPosition: args.savedPosition,
            externalSubtitles: args.externalSubtitles,
            mpvArgs: extraArgs || undefined,
            mpvPath: override || undefined,
            playlist,
            playlistStartIndex,
        })

        if (!result.ok) {
            log.warn("mpv launch failed:", result.error)
            toast.error(result.error || "Failed to launch mpv")
            setActive(false)
            setSession(null)
            return result
        }

        toast.success("Playing in mpv")
        return result
    }, [serverStatus, detection.found, override, extraArgs, clientId, getHMACTokenQueryParam, setActive, setSession, setState])
}

// Completion threshold for auto-syncing AniList progress when mpv exits.
// Mirrors the server-side rule used by the regular playback manager (a
// file watched past ~80% counts as "watched"). When mpv emits EOF the
// user definitely saw the credits, so we additionally treat that as a
// completion regardless of where the time-pos was at exit.
const CLIENT_MPV_COMPLETION_THRESHOLD = 0.8

// Subscribes to mpv:state / mpv:exited IPC events and pushes them into
// the global atoms. Also drives the auto-progress-sync behaviour: when
// mpv exits and the session was watched past the completion threshold,
// the existing /playback-manager/sync-current-progress endpoint is
// invoked so AniList progress + watch history get updated through the
// same code path as built-in playback. The manual-tracking session
// started in handle-play-media.ts is always cancelled on exit so it
// doesn't keep emitting heartbeat events into the void.
//
// Mount once at the app root.
export function useClientMpvEventBridge() {
    const setState = useSetAtom(__clientMpv_stateAtom)
    const setActive = useSetAtom(__clientMpv_activeAtom)
    const [session, setSession] = useAtom(__clientMpv_sessionAtom)
    const state = useAtomValue(__clientMpv_stateAtom)
    const clientId = useAtomValue(clientIdAtom)

    // Hold the live session/state in refs so the IPC callbacks (which
    // are registered once on mount) can read the latest values without
    // re-binding on every state change. Re-binding would briefly drop
    // the IPC listener and lose events.
    const sessionRef = React.useRef(session)
    const stateRef = React.useRef(state)
    const clientIdRef = React.useRef(clientId)
    React.useEffect(() => { sessionRef.current = session }, [session])
    React.useEffect(() => { stateRef.current = state }, [state])
    React.useEffect(() => { clientIdRef.current = clientId }, [clientId])

    const { mutate: syncProgress } = usePlaybackSyncCurrentProgress()
    const { mutate: cancelManualTracking } = usePlaybackCancelManualTracking({})
    const { mutate: startManualTracking } = usePlaybackStartManualTracking()

    React.useEffect(() => {
        if (!isInsideDenshi()) return
        if (!window.electron?.on) return

        const offState = window.electron.on("mpv:state", (s: ClientMpvState) => {
            setState(s)
        })
        const offPlaylist = window.electron.on("mpv:playlist-changed", (info: ClientMpvPlaylistChangedInfo) => {
            log.info("mpv playlist position changed", info)
            const prevSession = sessionRef.current
            const prevState = stateRef.current
            if (!info?.item) return

            // If the prior episode was watched past the completion
            // threshold, treat the playlist-advance as a "finished"
            // event for that episode and sync its AniList progress.
            // Otherwise just cancel its manual tracking; we don't want
            // a partially-watched episode showing up as completed.
            if (prevSession) {
                const ratio = prevState && prevState.duration > 0
                    ? prevState.timePos / prevState.duration
                    : 0
                if (ratio >= CLIENT_MPV_COMPLETION_THRESHOLD) {
                    log.info("Prior episode passed completion threshold; syncing before swap", {
                        mediaId: prevSession.mediaId,
                        episode: prevSession.episodeNumber,
                        ratio,
                    })
                    syncProgress()
                } else {
                    cancelManualTracking()
                }
            }

            // Re-key the active session so progress / continuity writes
            // attribute to the new episode going forward.
            setSession({
                mediaId: info.item.mediaId,
                episodeNumber: info.item.episodeNumber,
                filePath: info.item.filePath,
                fileTitle: info.item.fileTitle,
                totalDuration: null,
                startedAt: Date.now(),
            })
            // Reset state — duration / time-pos for the new file haven't
            // arrived yet, and we don't want the continuity flusher to
            // accidentally write the old position against the new
            // episode in the gap.
            setState(null)

            // Register the new episode with the playback manager so
            // sync-current-progress (fired on EOF/exit) targets the
            // right AniList entry.
            startManualTracking({
                mediaId: info.item.mediaId,
                episodeNumber: info.item.episodeNumber,
                clientId: clientIdRef.current || "",
            })
        })
        const offExit = window.electron.on("mpv:exited", (info: ClientMpvExitedInfo) => {
            log.info("mpv exited", info)
            const exitSession = sessionRef.current
            const exitState = stateRef.current
            setActive(false)

            const completionRatio = exitState && exitState.duration > 0
                ? exitState.timePos / exitState.duration
                : 0
            const watchedEnough = info?.completedNaturally || completionRatio >= CLIENT_MPV_COMPLETION_THRESHOLD

            if (exitSession && watchedEnough) {
                log.info("Client mpv passed completion threshold — syncing progress", {
                    mediaId: exitSession.mediaId,
                    episode: exitSession.episodeNumber,
                    completionRatio,
                })
                // syncCurrentProgress reads the manual-tracking state
                // that handle-play-media registered on launch. It
                // updates AniList and refreshes the local collection.
                syncProgress()
            } else if (exitSession) {
                // User closed mpv mid-episode; tear down the
                // manual-tracking heartbeat so it doesn't keep firing
                // playback-state events for an episode that's no
                // longer playing.
                cancelManualTracking()
            }

            // Hold onto the session for one beat so a follow-up
            // "completed naturally" trigger can match it to a media id,
            // then clear it on the next tick to free state.
            setTimeout(() => setSession(null), 0)
            setState(null)
            if (info && !info.completedNaturally && info.error) {
                toast.error(`mpv exited unexpectedly: ${info.error}`)
            }
        })

        return () => {
            try { offState && offState() } catch {}
            try { offExit && offExit() } catch {}
            try { offPlaylist && offPlaylist() } catch {}
        }
    }, [setState, setActive, setSession, syncProgress, cancelManualTracking, startManualTracking])
}

// How often to push the current time-pos to seanime's Continuity store
// while mpv is playing. Continuity is what powers "resume where you left
// off" — flushing ~every 10 seconds keeps the saved position fresh
// without hammering the database.
const CLIENT_MPV_CONTINUITY_FLUSH_MS = 10_000

// Drives Continuity updates while mpv is playing. Reads the live state
// pushed by useClientMpvEventBridge and posts to
// /api/v1/continuity/item/{id} on a slow interval (10 s), plus one
// final write at exit so the user can resume from the right spot.
// Mount once at the app root next to useClientMpvEventBridge.
export function useClientMpvContinuitySync() {
    const session = useAtomValue(__clientMpv_sessionAtom)
    const state = useAtomValue(__clientMpv_stateAtom)
    const active = useAtomValue(__clientMpv_activeAtom)

    const { mutate: updateContinuity } = useUpdateContinuityWatchHistoryItem()

    // Cache the most recent write so we don't repost identical state.
    const lastFlushedRef = React.useRef<{ time: number; flushedAt: number } | null>(null)

    React.useEffect(() => {
        if (!isInsideDenshi()) return
        if (!active || !session) {
            lastFlushedRef.current = null
            return
        }

        const flush = () => {
            const s = state
            const sess = session
            if (!s || !sess) return
            // Skip blank / pre-load states.
            if (!s.duration || s.duration <= 0) return
            if (!Number.isFinite(s.timePos)) return

            const now = Date.now()
            const prev = lastFlushedRef.current
            if (prev && now - prev.flushedAt < CLIENT_MPV_CONTINUITY_FLUSH_MS) return
            // Skip if time hasn't actually moved (paused mpv).
            if (prev && Math.abs(prev.time - s.timePos) < 1) return

            lastFlushedRef.current = { time: s.timePos, flushedAt: now }

            updateContinuity({
                options: {
                    currentTime: s.timePos,
                    duration: s.duration,
                    mediaId: sess.mediaId,
                    episodeNumber: sess.episodeNumber,
                    filepath: sess.filePath,
                    // "external_player" is the existing Continuity bucket
                    // used by the external-player-link feature; client-mpv
                    // is structurally identical (we launch a separate
                    // player and report progress back over HTTP) so we
                    // reuse it rather than introducing a new variant.
                    kind: "external_player",
                },
            })
        }

        // Push immediately when state first becomes available (so reloads
        // pick up the latest position quickly), then on every state tick
        // (the throttle inside flush enforces the actual cadence).
        flush()
    }, [active, session, state, updateContinuity])
}
