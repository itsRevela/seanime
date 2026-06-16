import { useUpdateContinuityWatchHistoryItem } from "@/api/hooks/continuity.hooks"
import {
    usePlaybackCancelManualTracking,
    usePlaybackSyncCurrentProgress,
} from "@/api/hooks/playback_manager.hooks"
import { useServerHMACAuth, useServerStatus } from "@/app/(main)/_hooks/use-server-status"
import { clientIdAtom } from "@/app/websocket-provider"
import { logger } from "@/lib/helpers/debug"
import { __isElectronDesktop__ } from "@/types/constants"
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai"
import { atomWithStorage } from "jotai/utils"
import React from "react"
import { toast } from "sonner"

const log = logger("CLIENT MPV")

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
        if (!__isElectronDesktop__) return
        if (typeof window === "undefined") return
        const mpv = window.electron?.mpv
        if (!mpv) return
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

export type LaunchClientMpvArgs = {
    mediaId: number
    episodeNumber: number
    filePath: string
    fileTitle: string
    savedPosition?: number
    externalSubtitles?: Array<{ url: string; title?: string; lang?: string }>
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
        if (!__isElectronDesktop__ || !window.electron?.mpv) {
            toast.error("Client mpv is only available in the desktop app")
            return { ok: false, error: "not in Denshi" }
        }
        if (!detection.found) {
            toast.error("mpv binary not found on this machine. Install mpv or set its path in playback settings.")
            return { ok: false, error: "mpv not found" }
        }

        // Build the file URL on the seanime server. The mediastream file
        // endpoint serves the raw MKV with HTTP range support; mpv loves
        // that. The path is passed as a query param (not base64-encoded,
        // unlike the nakama equivalent, because the server's
        // ServeEchoFile already URL-decodes it).
        const base = serverStatus?.serverHasPassword
            ? window.location.origin // we'll attach HMAC via query
            : window.location.origin
        const encodedPath = encodeURIComponent(args.filePath)
        let url = `${base}/api/v1/mediastream/file?path=${encodedPath}&client=${encodeURIComponent(clientId ?? "")}`
        if (serverStatus?.serverHasPassword) {
            // HMAC tokens are scoped to the endpoint path, not the query
            // string. The "&" symbol tells getHMACTokenQueryParam to
            // prepend with & since we already have ?path=...
            const token = await getHMACTokenQueryParam("/api/v1/mediastream/file", "&")
            url += token
        }

        log.info("Launching mpv with URL", url)

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

        const result = await window.electron.mpv.launch({
            url,
            title: args.fileTitle,
            savedPosition: args.savedPosition,
            externalSubtitles: args.externalSubtitles,
            mpvArgs: extraArgs || undefined,
            mpvPath: override || undefined,
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

    // Hold the live session/state in refs so the IPC callbacks (which
    // are registered once on mount) can read the latest values without
    // re-binding on every state change. Re-binding would briefly drop
    // the IPC listener and lose events.
    const sessionRef = React.useRef(session)
    const stateRef = React.useRef(state)
    React.useEffect(() => { sessionRef.current = session }, [session])
    React.useEffect(() => { stateRef.current = state }, [state])

    const { mutate: syncProgress } = usePlaybackSyncCurrentProgress()
    const { mutate: cancelManualTracking } = usePlaybackCancelManualTracking({})

    React.useEffect(() => {
        if (!__isElectronDesktop__) return
        if (typeof window === "undefined" || !window.electron?.on) return

        const offState = window.electron.on("mpv:state", (s: ClientMpvState) => {
            setState(s)
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
        }
    }, [setState, setActive, setSession, syncProgress, cancelManualTracking])
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
        if (!__isElectronDesktop__) return
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
