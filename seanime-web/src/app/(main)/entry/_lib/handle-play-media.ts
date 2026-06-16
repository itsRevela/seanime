import { Anime_Episode } from "@/api/generated/types"
import { useGetContinuityWatchHistory } from "@/api/hooks/continuity.hooks"
import { useDirectstreamPlayLocalFile } from "@/api/hooks/directstream.hooks"
import { useNakamaPlayVideo } from "@/api/hooks/nakama.hooks"
import { usePlaybackPlayVideo, usePlaybackStartManualTracking } from "@/api/hooks/playback_manager.hooks"
import {
    ElectronPlaybackMethod,
    PlaybackDownloadedMedia,
    useCurrentDevicePlaybackSettings,
    useExternalPlayerLink,
} from "@/app/(main)/_atoms/playback.atoms"
import { useTorrentstreamAutoplay } from "@/app/(main)/_features/autoplay/autoplay"
import { useLaunchClientMpv } from "@/app/(main)/_features/client-mpv/client-mpv"
import { __mpt_currentExternalPlayerLinkAtom } from "@/app/(main)/_features/progress-tracking/manual-progress-tracking"
import { useServerHMACAuth, useServerStatus } from "@/app/(main)/_hooks/use-server-status"
import { useMediastreamActiveOnDevice, useMediastreamCurrentFile } from "@/app/(main)/mediastream/_lib/mediastream.atoms"
import { clientIdAtom } from "@/app/websocket-provider"
import { ExternalPlayerLink } from "@/lib/external-player-link/external-player-link"
import { openTab } from "@/lib/helpers/browser"
import { logger } from "@/lib/helpers/debug"
import { useRouter } from "@/lib/navigation"
import { __isElectronDesktop__ } from "@/types/constants"
import { useAtomValue, useSetAtom } from "jotai"
import React from "react"
import { toast } from "sonner"

export function useHandlePlayMedia() {
    const router = useRouter()
    const serverStatus = useServerStatus()
    const clientId = useAtomValue(clientIdAtom)

    const { activeOnDevice: mediastreamActiveOnDevice } = useMediastreamActiveOnDevice()
    const { setFilePath: setMediastreamFilePath } = useMediastreamCurrentFile()

    const { mutate: startManualTracking, isPending: isStarting } = usePlaybackStartManualTracking()
    const setCurrentExternalPlayerLink = useSetAtom(__mpt_currentExternalPlayerLinkAtom)

    const { downloadedMediaPlayback, electronPlaybackMethod } = useCurrentDevicePlaybackSettings()
    const { externalPlayerLink } = useExternalPlayerLink()
    const { getHMACTokenQueryParam: getServerHMACTokenQueryParam } = useServerHMACAuth()

    // Play using desktop external player
    const { mutate: playVideo } = usePlaybackPlayVideo()
    const { mutate: playNakamaVideo } = useNakamaPlayVideo()

    const { mutate: directstreamPlayLocalFile } = useDirectstreamPlayLocalFile()

    const { setTorrentstreamAutoplayInfo } = useTorrentstreamAutoplay()

    const { getForcePlaybackMethod, resetForcePlaybackMethod } = useForcePlaybackMethod()

    const launchClientMpv = useLaunchClientMpv()
    // Pull the continuity history once (it's cached for the session) so
    // the client-mpv launch path can resume from the user's last
    // playback position without an extra round-trip on every play.
    const { data: continuityHistory } = useGetContinuityWatchHistory()

    function playMediaFile({
        path,
        mediaId,
        episode,
    }: {
        path: string,
        mediaId: number,
        episode: Anime_Episode
    }) {
        const anidbEpisode = episode.localFile?.metadata?.aniDBEpisode ?? ""

        const forcePlaybackMethod = getForcePlaybackMethod()
        resetForcePlaybackMethod()

        setTorrentstreamAutoplayInfo(null)

        if (episode._isNakamaEpisode) {
            // If external player link is set, open the media file in the external player
            if ((!forcePlaybackMethod && downloadedMediaPlayback === PlaybackDownloadedMedia.ExternalPlayerLink) ||
                (forcePlaybackMethod && forcePlaybackMethod === "externalPlayerLink")
            ) {
                const link = new ExternalPlayerLink(externalPlayerLink)
                link.setEpisodeNumber(episode.progressNumber)
                link.setMediaTitle(episode.baseAnime?.title?.userPreferred)
                link.to({
                    endpoint: "/api/v1/nakama/stream?type=file&path=" + Buffer.from(path).toString("base64"),
                    onTokenQueryParam: () => getServerHMACTokenQueryParam("/api/v1/nakama/stream", "&"),
                }).then()
                openTab(link.getFullUrl())
                setCurrentExternalPlayerLink(link.getFullUrl())

                if (episode?.progressNumber && episode.type === "main") {
                    logger("PLAY MEDIA").error("Starting manual tracking for nakama file")
                    // Start manual tracking
                    React.startTransition(() => {
                        startManualTracking({
                            mediaId: mediaId,
                            episodeNumber: episode?.progressNumber,
                            clientId: clientId || "",
                        })
                    })
                } else {
                    logger("PLAY MEDIA").warning("No manual tracking, progress number is not set for nakama file")
                }
                return
            }
            return playNakamaVideo({
                path,
                mediaId,
                anidbEpisode,
                clientId: clientId ?? "",
                forcePlaybackMethod: forcePlaybackMethod || undefined,
            })
        }

        logger("PLAY MEDIA").info("Playing media file", path)

        //
        // Client-side mpv (Denshi spawns mpv.exe locally and streams from
        // the seanime server). Checked before the native-player branch so
        // it can fully replace built-in playback for users who prefer mpv.
        //
        // We hook into the existing manual-tracking pipeline so AniList
        // progress sync, "Update progress" UX, and the watch-history
        // map continue to work without a parallel code path. The mpv
        // event bridge (in client-mpv.ts) will trigger sync-current-progress
        // when mpv exits after watching to the end.
        //
        if (__isElectronDesktop__ && (
            (!forcePlaybackMethod && electronPlaybackMethod === ElectronPlaybackMethod.ClientMpv) ||
            (forcePlaybackMethod && forcePlaybackMethod === "clientmpv")
        )) {
            const fileTitle = episode?.displayTitle
                || episode?.baseAnime?.title?.userPreferred
                || path.split(/[\\/]/).pop()
                || "Seanime"

            // Look up the user's most recent stop position for this
            // episode. Continuity stores per-mediaId state, so we only
            // resume when the saved entry is for the SAME episode the
            // user is now launching — otherwise we'd jump to the wrong
            // timestamp when starting a different episode of the same
            // show.
            let savedPosition: number | undefined
            const historyItem = continuityHistory?.[mediaId]
            if (historyItem
                && historyItem.episodeNumber === episode?.progressNumber
                && historyItem.currentTime
                && historyItem.duration) {
                const ratio = historyItem.currentTime / historyItem.duration
                // Skip resume for near-start (<2%) or already-finished
                // (>92%) positions so we don't replay the credits or
                // jump 4 seconds in.
                if (ratio > 0.02 && ratio < 0.92) {
                    savedPosition = historyItem.currentTime
                }
            }

            React.startTransition(() => {
                launchClientMpv({
                    mediaId,
                    episodeNumber: episode?.progressNumber ?? 0,
                    filePath: path,
                    fileTitle,
                    savedPosition,
                }).then(result => {
                    if (result?.ok && episode?.progressNumber && episode.type === "main") {
                        // Register the play with seanime's server so the
                        // existing AniList sync flow can target the right
                        // media ID when mpv finishes. Same hook the
                        // external-player-link path uses.
                        startManualTracking({
                            mediaId,
                            episodeNumber: episode.progressNumber,
                            clientId: clientId || "",
                        })
                    }
                }).catch(err => {
                    logger("PLAY MEDIA").error("Client mpv launch failed", err)
                })
            })
            return
        }

        //
        // Electron native player
        //
        if (__isElectronDesktop__ && (
            (!forcePlaybackMethod && electronPlaybackMethod === ElectronPlaybackMethod.NativePlayer) ||
            (forcePlaybackMethod && forcePlaybackMethod === "nativeplayer")
        )) {
            directstreamPlayLocalFile({ path, clientId: clientId ?? "" })
            return
        }

        // If external player link is set, open the media file in the external player
        if ((!forcePlaybackMethod && downloadedMediaPlayback === PlaybackDownloadedMedia.ExternalPlayerLink) ||
            (forcePlaybackMethod && forcePlaybackMethod === "externalPlayerLink")
        ) {
            if (!externalPlayerLink) {
                toast.error("External player link is not set.")
                return
            }

            logger("PLAY MEDIA").info("Opening media file in external player", externalPlayerLink, path)

            setMediastreamFilePath(path)
            React.startTransition(() => {
                router.push(`/medialinks?id=${mediaId}`)
            })
            return
        }

        // Handle media streaming
        if (serverStatus?.mediastreamSettings?.transcodeEnabled && mediastreamActiveOnDevice) {
            setMediastreamFilePath(path)
            React.startTransition(() => {
                router.push(`/mediastream?id=${mediaId}`)
            })
            return
        }

        return playVideo({ path })
    }

    return {
        isUsingNativePlayer: __isElectronDesktop__ && electronPlaybackMethod === ElectronPlaybackMethod.NativePlayer,
        playMediaFile,
    }
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export type ForcePlaybackMethod = "playbackmanager" | "nativeplayer" | "clientmpv" | "externalPlayerLink"

// maintain value outside react
const __forcePlaybackMethodStore = (() => {
    let current: ForcePlaybackMethod | undefined = undefined
    const listeners = new Set<() => void>()
    return {
        get: () => current,
        set: (val: ForcePlaybackMethod | undefined) => {
            current = val
            listeners.forEach(l => l())
        },
        subscribe: (l: () => void) => {
            listeners.add(l)
            return () => listeners.delete(l)
        },
    }
})()

// Returns the forced playback method, if any
export function useForcePlaybackMethod() {
    const queueRef = React.useRef<Array<{ method: ForcePlaybackMethod, cb?: () => void }>>([])
    const processingRef = React.useRef(false)

    const processQueue = React.useCallback(() => {
        if (processingRef.current) return
        if (queueRef.current.length === 0) return
        processingRef.current = true
        const { method, cb } = queueRef.current[0]
        __forcePlaybackMethodStore.set(method)
        Promise.resolve().then(() => {
            cb?.()
            // devnote: don't, this resets playback method before user selects a torrent
            // __forcePlaybackMethodStore.set(undefined)
            queueRef.current.shift()
            processingRef.current = false
            processQueue()
        })
    }, [])

    const forcePlaybackMethodFn = React.useCallback((method: ForcePlaybackMethod | undefined, cb?: () => void) => {
        if (!method) {
            cb?.()
            return
        }
        queueRef.current.push({ method, cb })
        processQueue()
    }, [processQueue])

    const getForcePlaybackMethod = React.useCallback(() => __forcePlaybackMethodStore.get(), [])

    const resetForcePlaybackMethod = React.useCallback(() => {
        queueRef.current = []
        processingRef.current = false
        __forcePlaybackMethodStore.set(undefined)
    }, [])

    return { forcePlaybackMethodFn, resetForcePlaybackMethod, getForcePlaybackMethod }
}

