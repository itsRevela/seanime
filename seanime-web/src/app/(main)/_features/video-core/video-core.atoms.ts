import { VideoCore_PlaybackType, VideoCore_VideoPlaybackInfo, VideoCore_VideoSource, VideoCore_VideoSubtitleTrack } from "@/api/generated/types"
import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"

export type VideoCoreLifecycleState = {
    active: boolean
    playbackInfo: VideoCore_VideoPlaybackInfo | null
    playbackError: string | null
    loadingState: string | null
}

export type {
    VideoCore_VideoSubtitleTrack, VideoCore_PlaybackType, VideoCore_VideoSource, VideoCore_VideoPlaybackInfo,
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export type VideoCoreSettings = {
    preferredSubtitleLanguage: string
    preferredSubtitleBlacklist: string
    preferredAudioLanguage: string
    subtitleDelay: number // in seconds
    // Video enhancement settings
    videoEnhancement: {
        enabled: boolean
        contrast: number      // 0.8 - 1.2 (1.0 = default)
        saturation: number    // 0.8 - 1.3 (1.0 = default)
        brightness: number    // 0.9 - 1.1 (1.0 = default)
    }
    // Subtitle customization settings (ASS)
    subtitleCustomization: {
        enabled: boolean
        fontSize?: number
        fontName?: string
        primaryColor?: string
        outlineColor?: string
        backColor?: string
        backColorOpacity?: number
        outline?: number
        shadow?: number
    }
    // Caption customization settings (non-ASS)
    captionCustomization: {
        fontSize?: number
        textColor?: string
        backgroundColor?: string
        backgroundOpacity?: number
        textShadow?: number
        textShadowColor?: string
    }
}

export const vc_initialSettings: VideoCoreSettings = {
    preferredSubtitleLanguage: "en,eng,english",
    preferredSubtitleBlacklist: "",
    preferredAudioLanguage: "jpn,jp,jap,japanese",
    subtitleDelay: 0,
    videoEnhancement: {
        enabled: true,
        contrast: 1.05,
        saturation: 1.1,
        brightness: 1.02,
    },
    subtitleCustomization: {
        enabled: false,
    },
    captionCustomization: {},
}

// Wrapped atom for backward compatibility
export const vc_settingsRaw = atomWithStorage<Partial<VideoCoreSettings>>("sea-video-core-settings",
    vc_initialSettings,
    undefined,
    { getOnInit: true })

export const vc_settings = atom(
    (get) => {
        const settings = get(vc_settingsRaw)
        return {
            ...vc_initialSettings,
            ...settings,
            subtitleCustomization: {
                ...vc_initialSettings.subtitleCustomization,
                ...(settings.subtitleCustomization || {}),
            },
            captionCustomization: {
                ...vc_initialSettings.captionCustomization,
                ...(settings.captionCustomization || {}),
            },
            videoEnhancement: {
                ...vc_initialSettings.videoEnhancement,
                ...(settings.videoEnhancement || {}),
            },
        } as VideoCoreSettings
    },
    (get, set, update: VideoCoreSettings) => {
        set(vc_settingsRaw, update)
    },
)

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export interface VideoCoreKeybindings {
    seekForward: { key: string; value: number }
    seekBackward: { key: string; value: number }
    seekForwardFine: { key: string; value: number }
    seekBackwardFine: { key: string; value: number }
    nextChapter: { key: string }
    previousChapter: { key: string }
    volumeUp: { key: string; value: number }
    volumeDown: { key: string; value: number }
    mute: { key: string }
    cycleSubtitles: { key: string }
    cycleAudio: { key: string }
    nextEpisode: { key: string }
    previousEpisode: { key: string }
    fullscreen: { key: string }
    pictureInPicture: { key: string }
    increaseSpeed: { key: string; value: number }
    decreaseSpeed: { key: string; value: number }
    takeScreenshot: { key: string }
    openInSight: { key: string }
    statsForNerds: { key: string }
}

export const vc_defaultKeybindings: VideoCoreKeybindings = {
    seekForward: { key: "KeyD", value: 30 },
    seekBackward: { key: "KeyA", value: 30 },
    seekForwardFine: { key: "ArrowRight", value: 2 },
    seekBackwardFine: { key: "ArrowLeft", value: 2 },
    nextChapter: { key: "KeyE" },
    previousChapter: { key: "KeyQ" },
    volumeUp: { key: "ArrowUp", value: 5 },
    volumeDown: { key: "ArrowDown", value: 5 },
    mute: { key: "KeyM" },
    cycleSubtitles: { key: "KeyJ" },
    cycleAudio: { key: "KeyK" },
    nextEpisode: { key: "KeyN" },
    previousEpisode: { key: "KeyB" },
    fullscreen: { key: "KeyF" },
    pictureInPicture: { key: "KeyP" },
    increaseSpeed: { key: "BracketRight", value: 0.1 },
    decreaseSpeed: { key: "BracketLeft", value: 0.1 },
    takeScreenshot: { key: "KeyI" },
    openInSight: { key: "KeyH" },
    statsForNerds: { key: "KeyZ" },
}

const vc_keybindingsRaw = atomWithStorage<Partial<VideoCoreKeybindings>>("sea-video-core-keybindings",
    vc_defaultKeybindings,
    undefined,
    { getOnInit: true })

export const vc_keybindingsAtom = atom(
    (get) => {
        const stored = get(vc_keybindingsRaw)
        // Merge stored with defaults
        return {
            ...vc_defaultKeybindings,
            ...stored,
        } as VideoCoreKeybindings
    },
    (get, set, update: VideoCoreKeybindings) => {
        set(vc_keybindingsRaw, update)
    },
)

export const vc_useLibassRendererAtom = atomWithStorage("sea-video-core-use-libass-renderer", true, undefined, { getOnInit: true })

export const vc_showChapterMarkersAtom = atomWithStorage("sea-video-core-chapter-markers", true, undefined, { getOnInit: true })
export const vc_highlightOPEDChaptersAtom = atomWithStorage("sea-video-core-highlight-op-ed-chapters", true, undefined, { getOnInit: true })
export const vc_beautifyImageAtom = atomWithStorage("sea-video-core-increase-saturation", false, undefined, { getOnInit: true })
export const vc_autoNextAtom = atomWithStorage("sea-video-core-auto-next", true, undefined, { getOnInit: true })
export const vc_autoPlayVideoAtom = atomWithStorage("sea-video-core-auto-play", true, undefined, { getOnInit: true })
export const vc_autoSkipOPEDAtom = atomWithStorage("sea-video-core-auto-skip-op-ed", false, undefined, { getOnInit: true })
export const vc_storedVolumeAtom = atomWithStorage("sea-video-core-volume", 1, undefined, { getOnInit: true })
export const vc_storedMutedAtom = atomWithStorage("sea-video-core-muted", false, undefined, { getOnInit: true })
export const vc_storedPlaybackRateAtom = atomWithStorage("sea-video-core-playback-rate", 1, undefined, { getOnInit: true })
export const vc_showStatsForNerdsAtom = atomWithStorage("sea-video-core-show-stats-for-nerds", false, undefined, { getOnInit: true })

// vc_rememberedAudioLanguageAtom / vc_rememberedSubtitleLanguageAtom
//
// Persist the audio / subtitle language the user last picked via the track
// menu or the cycle keybindings, so the next episode (and subsequent
// sessions) auto-select the same language instead of falling back to the
// global preferredAudioLanguage / preferredSubtitleLanguage defaults.
//
// Values are language codes ("eng", "jpn", ...) that get prepended to the
// effective preferred-language list when constructing the audio/subtitle
// managers; the existing default-selection logic then naturally picks the
// remembered language first if the new file has a matching track, and
// falls through to the global preference list when it does not.
//
// "" means "no override, use global preference".
// "none" on the subtitle atom means "user explicitly turned subs off" — the
// existing getDefaultSubtitleTrackNumber helper treats "none" as a sentinel
// for NO_TRACK_NUMBER.
export const vc_rememberedAudioLanguageAtom = atomWithStorage(
    "sea-video-core-remembered-audio-language",
    "",
    undefined,
    { getOnInit: true },
)
export const vc_rememberedSubtitleLanguageAtom = atomWithStorage(
    "sea-video-core-remembered-subtitle-language",
    "",
    undefined,
    { getOnInit: true },
)
