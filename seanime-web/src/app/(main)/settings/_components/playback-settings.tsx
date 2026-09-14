import {
    ElectronPlaybackMethod,
    PlaybackDownloadedMedia,
    PlaybackTorrentStreaming,
    useCurrentDevicePlaybackSettings,
    useExternalPlayerLink,
} from "@/app/(main)/_atoms/playback.atoms"
import {
    __clientMpv_extraArgsAtom,
    __clientMpv_pathOverrideAtom,
    useClientMpvAvailability,
    useHasClientMpvBridge,
} from "@/app/(main)/_features/client-mpv/client-mpv"
import {
    __clientMpv_anime4kModeAtom,
    CLIENT_MPV_ANIME4K_OPTIONS,
    ClientMpvAnime4kMode,
} from "@/app/(main)/_features/client-mpv/client-mpv-anime4k"
import { useServerStatus } from "@/app/(main)/_hooks/use-server-status"
import { useMediastreamActiveOnDevice } from "@/app/(main)/mediastream/_lib/mediastream.atoms"
import { SettingsCard, SettingsPageHeader } from "@/app/(main)/settings/_components/settings-card"
import { __settings_tabAtom } from "@/app/(main)/settings/_components/settings-page.atoms"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { cn } from "@/components/ui/core/styling"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { TextInput } from "@/components/ui/text-input"
import { __isElectronDesktop__ } from "@/types/constants"
import { useAtom, useSetAtom } from "jotai"
import React from "react"
import { BiDesktop } from "react-icons/bi"
import { LuCirclePlay, LuClapperboard, LuExternalLink, LuLaptop } from "react-icons/lu"
import { MdOutlineBroadcastOnHome } from "react-icons/md"
import { RiSettings3Fill } from "react-icons/ri"
import { toast } from "sonner"

type PlaybackSettingsProps = {
    children?: React.ReactNode
}

export function PlaybackSettings(props: PlaybackSettingsProps) {

    const {
        children,
        ...rest
    } = props

    const serverStatus = useServerStatus()

    const {
        downloadedMediaPlayback,
        setDownloadedMediaPlayback,
        torrentStreamingPlayback,
        setTorrentStreamingPlayback,
        electronPlaybackMethod,
        setElectronPlaybackMethod,
    } = useCurrentDevicePlaybackSettings()

    const { activeOnDevice, setActiveOnDevice } = useMediastreamActiveOnDevice()
    const { externalPlayerLink } = useExternalPlayerLink()
    const setTab = useSetAtom(__settings_tabAtom)

    const usingNativePlayer = __isElectronDesktop__ && electronPlaybackMethod === ElectronPlaybackMethod.NativePlayer
    // The mpv card uses a RUNTIME check (window.electron.mpv presence),
    // not the build-time __isElectronDesktop__ constant — that constant
    // is baked false in the Docker-served web bundle even when Denshi is
    // the actual client (Denshi loads the UI from the remote server).
    const hasClientMpvBridge = useHasClientMpvBridge()
    const usingClientMpv = electronPlaybackMethod === ElectronPlaybackMethod.ClientMpv

    // Probe for mpv on the user's machine. Only meaningful inside
    // Denshi — useClientMpvAvailability short-circuits when the bridge
    // is absent.
    const clientMpvDetection = useClientMpvAvailability()
    const [clientMpvPathOverride, setClientMpvPathOverride] = useAtom(__clientMpv_pathOverrideAtom)
    const [clientMpvExtraArgs, setClientMpvExtraArgs] = useAtom(__clientMpv_extraArgsAtom)

    return (
        <>
            <div className="space-y-4">
                <SettingsPageHeader
                    title="Video playback"
                    description="Choose how anime is played on this device"
                    icon={LuCirclePlay}
                />

                <div className="flex items-center gap-2 text-sm bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3 border border-gray-200 dark:border-gray-800">
                    <BiDesktop className="text-lg text-gray-500" />
                    <span className="text-gray-600 dark:text-gray-400">Device:</span>
                    <span className="font-medium">{serverStatus?.clientDevice || "-"}</span>
                    <span className="text-gray-400">•</span>
                    <span className="font-medium">{serverStatus?.clientPlatform || "-"}</span>
                </div>
            </div>

            {(!externalPlayerLink && (downloadedMediaPlayback === PlaybackDownloadedMedia.ExternalPlayerLink || torrentStreamingPlayback === PlaybackTorrentStreaming.ExternalPlayerLink)) && (
                <Alert
                    intent="alert-basic"
                    description={
                        <div className="flex items-center justify-between gap-3">
                            <span>No external player custom scheme has been set</span>
                            <Button
                                intent="gray-outline"
                                size="sm"
                                onClick={() => setTab("external-player-link")}
                            >
                                Add
                            </Button>
                        </div>
                    }
                />
            )}

            {__isElectronDesktop__ && (
                <SettingsCard
                    title="Seanime Denshi"
                    className="border-2 border-dashed dark:border-gray-700 bg-gradient-to-r from-indigo-50/50 to-pink-50/50 dark:from-gray-900/20 dark:to-gray-900/20"
                >
                    <div className="space-y-4">

                        <div className="flex items-center gap-4">
                            <div className="p-3 rounded-lg bg-gradient-to-br from-indigo-500/20 to-indigo-500/20 border border-indigo-500/20">
                                <LuClapperboard className="text-2xl text-indigo-600 dark:text-indigo-400" />
                            </div>
                            <div className="flex-1">
                                <Switch
                                    label="Use built-in player"
                                    help="When enabled, all media playback will use the built-in player (overrides settings below)"
                                    value={electronPlaybackMethod === ElectronPlaybackMethod.NativePlayer}
                                    onValueChange={v => {
                                        setElectronPlaybackMethod(v ? ElectronPlaybackMethod.NativePlayer : ElectronPlaybackMethod.Default)
                                        toast.success("Playback settings updated")
                                    }}
                                />
                            </div>
                        </div>
                    </div>
                </SettingsCard>
            )}

            {/*
             * Client-side mpv. Lives in its own card because it must show
             * up even when the seanime-web bundle was NOT built with the
             * Denshi flag — Denshi running against a remote server loads
             * the regular web bundle from that server, where
             * __isElectronDesktop__ (build-time) is false. The runtime
             * check via window.electron.mpv presence is the right gate
             * here, regardless of which bundle is loaded.
             */}
            {hasClientMpvBridge && (
                <SettingsCard
                    title="Local mpv (Denshi)"
                    className="border-2 border-dashed dark:border-gray-700 bg-gradient-to-r from-indigo-50/50 to-pink-50/50 dark:from-gray-900/20 dark:to-gray-900/20"
                >
                    <div className="flex items-start gap-4">
                        <div className="p-3 rounded-lg bg-gradient-to-br from-indigo-500/20 to-indigo-500/20 border border-indigo-500/20">
                            <LuLaptop className="text-2xl text-indigo-600 dark:text-indigo-400" />
                        </div>
                        <div className="flex-1 space-y-3">
                            <Switch
                                label="Use local mpv on this device"
                                help={clientMpvDetection.found
                                    ? `Detected mpv at ${clientMpvDetection.path} (via ${clientMpvDetection.source}). Playback opens in mpv on this machine, streaming from the remote seanime server. Overrides downloaded-media / mediastream below.`
                                    : "Spawns mpv on this machine and streams from the seanime server. mpv is not currently detected — install it or set a custom path below."}
                                value={usingClientMpv}
                                onValueChange={v => {
                                    setElectronPlaybackMethod(v ? ElectronPlaybackMethod.ClientMpv : ElectronPlaybackMethod.Default)
                                    toast.success("Playback settings updated")
                                }}
                            />
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                <TextInput
                                    label="mpv path override"
                                    placeholder="Auto-detect (PATH, then well-known install locations)"
                                    value={clientMpvPathOverride}
                                    onValueChange={setClientMpvPathOverride}
                                    help="Full path to mpv.exe. Leave empty to auto-detect."
                                />
                                <TextInput
                                    label="Extra mpv args"
                                    placeholder="e.g. --hwdec=auto --vo=gpu-next"
                                    value={clientMpvExtraArgs}
                                    onValueChange={setClientMpvExtraArgs}
                                    help="Appended verbatim to every mpv launch."
                                />
                            </div>
                            <ClientMpvAnime4kSettings />
                        </div>
                    </div>
                </SettingsCard>
            )}

            <SettingsCard
                title="Downloaded Media"
                description="Choose how to play anime files stored on your device"
                className={cn(
                    "transition-all duration-200",
                    usingNativePlayer && "opacity-50",
                )}
            >
                <div className="space-y-4">

                    {/* Option Comparison */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {/* Desktop Player Option */}
                        <div
                            className={cn(
                                "p-4 rounded-lg border cursor-pointer transition-all",
                                downloadedMediaPlayback === PlaybackDownloadedMedia.Default && !activeOnDevice
                                    ? "border-[--brand] bg-brand-900/10"
                                    : "border-gray-700 hover:border-gray-600",
                            )}
                            onClick={() => {
                                setDownloadedMediaPlayback(PlaybackDownloadedMedia.Default)
                                setActiveOnDevice(false)
                                toast.success("Playback settings updated")
                            }}
                        >
                            <div className="flex items-start gap-3">
                                <LuLaptop className="text-xl text-brand-600 dark:text-brand-400 mt-1" />
                                <div className="flex-1 space-y-2">
                                    <div>
                                        <p className="font-medium">Desktop Media Player</p>
                                        <p className="text-xs text-gray-600 dark:text-gray-400">Opens files in your system player with automatic
                                                                                                tracking</p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Web Player Option */}
                        <div
                            className={cn(
                                "p-4 rounded-lg border cursor-pointer transition-all",
                                downloadedMediaPlayback === PlaybackDownloadedMedia.Default && activeOnDevice
                                    ? "border-[--brand] bg-brand-900/10"
                                    : "border-gray-700 hover:border-gray-600",
                                !serverStatus?.mediastreamSettings?.transcodeEnabled && "opacity-50",
                            )}
                            onClick={() => {
                                if (serverStatus?.mediastreamSettings?.transcodeEnabled) {
                                    setDownloadedMediaPlayback(PlaybackDownloadedMedia.Default)
                                    setActiveOnDevice(true)
                                    toast.success("Playback settings updated")
                                }
                            }}
                        >
                            <div className="flex items-start gap-3">
                                <MdOutlineBroadcastOnHome className="text-xl text-brand-600 dark:text-brand-400 mt-1" />
                                <div className="flex-1 space-y-2">
                                    <div>
                                        <p className="font-medium">Transcoding / Direct Play</p>
                                        <p className="text-xs text-gray-600 dark:text-gray-400">
                                            {serverStatus?.mediastreamSettings?.transcodeEnabled
                                                ? "Plays in browser with transcoding"
                                                : "Transcoding not enabled"
                                            }
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* External Player Option */}
                        <div
                            className={cn(
                                "p-4 rounded-lg border cursor-pointer transition-all",
                                downloadedMediaPlayback === PlaybackDownloadedMedia.ExternalPlayerLink
                                    ? "border-[--brand] bg-brand-900/10"
                                    : "border-gray-700 hover:border-gray-600",
                            )}
                            onClick={() => {
                                setDownloadedMediaPlayback(PlaybackDownloadedMedia.ExternalPlayerLink)
                                toast.success("Playback settings updated")
                            }}
                        >
                            <div className="flex items-start gap-3">
                                <LuExternalLink className="text-xl text-brand-600 dark:text-brand-400 mt-1" />
                                <div className="flex-1 space-y-2">
                                    <div>
                                        <p className="font-medium">External Player Link</p>
                                        <p className="text-xs text-gray-600 dark:text-gray-400">Send stream URL to another application</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </SettingsCard>

            <SettingsCard
                title="Torrent & Debrid Streaming"
                description="Choose how to play streamed content from torrents and debrid services"
                className={cn(
                    "transition-all duration-200",
                    usingNativePlayer && "opacity-50",
                )}
            >
                <div className="space-y-4">

                    {/* Option Comparison */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Desktop Player Option */}
                        <div
                            className={cn(
                                "p-4 rounded-lg border cursor-pointer transition-all",
                                torrentStreamingPlayback === PlaybackTorrentStreaming.Default
                                    ? "border-[--brand] bg-brand-900/10"
                                    : "border-gray-700 hover:border-gray-600",
                            )}
                            onClick={() => {
                                setTorrentStreamingPlayback(PlaybackTorrentStreaming.Default)
                                toast.success("Playback settings updated")
                            }}
                        >
                            <div className="flex items-start gap-3">
                                <LuLaptop className="text-xl text-brand-600 dark:text-brand-400 mt-1" />
                                <div className="flex-1 space-y-2">
                                    <div>
                                        <p className="font-medium">Desktop Media Player</p>
                                        <p className="text-xs text-gray-600 dark:text-gray-400">Opens streams in your system player with automatic
                                                                                                tracking</p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* External Player Option */}
                        <div
                            className={cn(
                                "p-4 rounded-lg border cursor-pointer transition-all",
                                torrentStreamingPlayback === PlaybackTorrentStreaming.ExternalPlayerLink
                                    ? "border-[--brand] bg-brand-900/10"
                                    : "border-gray-700 hover:border-gray-600",
                            )}
                            onClick={() => {
                                setTorrentStreamingPlayback(PlaybackTorrentStreaming.ExternalPlayerLink)
                                toast.success("Playback settings updated")
                            }}
                        >
                            <div className="flex items-start gap-3">
                                <LuExternalLink className="text-xl text-brand-600 dark:text-brand-400 mt-1" />
                                <div className="flex-1 space-y-2">
                                    <div>
                                        <p className="font-medium">External Player Link</p>
                                        <p className="text-xs text-gray-600 dark:text-gray-400">Send stream URL to another application</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </SettingsCard>

            <div className="flex items-center gap-2 text-sm text-gray-500 bg-gray-50 dark:bg-gray-900/30 rounded-lg p-3 border border-gray-200 dark:border-gray-800 border-dashed">
                <RiSettings3Fill className="text-base" />
                <span>Settings are saved automatically</span>
            </div>

        </>
    )
}

/**
 * Anime4K for client-side mpv: one-click install of the official GLSL pack
 * (downloaded by Denshi's main process into its user-data dir) plus the
 * default mode applied at launch. In-player, CTRL+1-6 switch between modes
 * and CTRL+0 turns Anime4K off — the dropdown here is only the startup default.
 */
function ClientMpvAnime4kSettings() {
    const [mode, setMode] = useAtom(__clientMpv_anime4kModeAtom)
    const [status, setStatus] = React.useState<"checking" | "installed" | "not-installed">("checking")
    const [installing, setInstalling] = React.useState(false)
    const [tag, setTag] = React.useState<string | null>(null)

    // Denshi older than 3.8.31 has the mpv bridge but not the Anime4K one —
    // render nothing rather than an install button that can't work.
    const hasAnime4kBridge = typeof window !== "undefined" && !!window.electron?.anime4k

    const refreshStatus = React.useCallback(async () => {
        const bridge = window.electron?.anime4k
        if (!bridge) {
            setStatus("not-installed")
            return
        }
        try {
            const res = await bridge.status()
            setTag(res.tag ?? null)
            setStatus(res.ok && res.installed ? "installed" : "not-installed")
        }
        catch {
            setStatus("not-installed")
        }
    }, [])

    React.useEffect(() => {
        refreshStatus()
    }, [refreshStatus])

    async function handleInstall() {
        const bridge = window.electron?.anime4k
        if (!bridge) return
        setInstalling(true)
        try {
            const res = await bridge.install()
            if (res.ok && res.installed) {
                toast.success("Anime4K shaders installed")
                setTag(res.tag ?? null)
                setStatus("installed")
            }
            else {
                toast.error(res.error || "Failed to install Anime4K shaders")
            }
        }
        catch (error: unknown) {
            toast.error(error instanceof Error ? error.message : "Failed to install Anime4K shaders")
        }
        finally {
            setInstalling(false)
        }
    }

    async function handleUninstall() {
        const bridge = window.electron?.anime4k
        if (!bridge) return
        setInstalling(true)
        try {
            const res = await bridge.uninstall()
            if (res.ok) {
                toast.success("Anime4K shaders removed")
                setMode("off") // don't reference shaders that no longer exist at the next launch
                setStatus("not-installed")
            }
            else {
                toast.error(res.error || "Failed to remove Anime4K shaders")
            }
        }
        catch (error: unknown) {
            toast.error(error instanceof Error ? error.message : "Failed to remove Anime4K shaders")
        }
        finally {
            setInstalling(false)
        }
    }

    if (!hasAnime4kBridge) return null

    return (
        <div className="space-y-2" data-client-mpv-anime4k-settings>
            {status === "installed" ? (
                <>
                    <Select
                        label="Anime4K upscaling"
                        options={CLIENT_MPV_ANIME4K_OPTIONS}
                        value={mode}
                        onValueChange={v => setMode(v as ClientMpvAnime4kMode)}
                        help={`Shaders installed (Anime4K ${tag ?? ""}). The selected mode applies when mpv starts; inside mpv, CTRL+a opens the preset menu, CTRL+1-6 switch modes A/B/C/A+A/B+B/C+A and CTRL+0 turns Anime4K off. HQ and CNN VL/UL variants want a decent GPU; Fast variants are for weaker machines.`}
                    />
                    <Button
                        intent="gray-subtle"
                        size="sm"
                        loading={installing}
                        onClick={handleUninstall}
                    >
                        Uninstall Anime4K shaders
                    </Button>
                </>
            ) : (
                <>
                    <Button
                        intent="primary-subtle"
                        size="sm"
                        loading={installing || status === "checking"}
                        onClick={handleInstall}
                    >
                        Install Anime4K shaders for mpv
                    </Button>
                    <p className="text-sm text-[--muted]">
                        Downloads the official Anime4K GLSL shaders (~3 MB) so mpv can upscale anime in real time, and adds CTRL+1-6 / CTRL+0
                        keybindings to mpv launched by Seanime. Your own mpv configuration is not modified.
                    </p>
                </>
            )}
        </div>
    )
}
