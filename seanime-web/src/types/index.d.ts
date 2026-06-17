import "@total-typescript/ts-reset"

declare global {
    interface AudioTrack {
        id: string;
        kind: string;
        label: string;
        language: string;
        enabled: boolean;
    }

    interface AudioTrackList extends EventTarget {
        readonly length: number;
        onchange: ((this: AudioTrackList, ev: Event) => any) | null;
        onaddtrack: ((this: AudioTrackList, ev: TrackEvent) => any) | null;
        onremovetrack: ((this: AudioTrackList, ev: TrackEvent) => any) | null;

        [index: number]: AudioTrack;

        getTrackById(id: string): AudioTrack | null;
    }

    interface HTMLMediaElement {
        readonly audioTracks: AudioTrackList | undefined;
    }

    interface Window {
        electron?: {
            window: {
                minimize: () => void;
                maximize: () => void;
                close: () => void;
                isMaximized: () => Promise<boolean>;
                isMinimizable: () => Promise<boolean>;
                isMaximizable: () => Promise<boolean>;
                isClosable: () => Promise<boolean>;
                isFullscreen: () => Promise<boolean>;
                setFullscreen: (fullscreen: boolean) => void;
                toggleMaximize: () => void;
                hide: () => void;
                show: () => void;
                isVisible: () => Promise<boolean>;
                setTitleBarStyle: (style: string) => void;
                getCurrentWindow: () => Promise<string>;
                isMainWindow: () => Promise<boolean>;
            };
            localServer: {
                getPort: () => Promise<number>;
            },
            startup: {
                ready: () => void;
            },
            media?: {
                setMetadata: (metadata: any) => Promise<boolean>
                clearSession: () => Promise<boolean>
                stopAllMedia: () => Promise<boolean>
            }
            on: (channel: string, callback: (...args: any[]) => void) => (() => void) | undefined;
            // Send events
            emit: (channel: string, data?: any) => void;
            // General send method
            send: (channel: string, ...args: any[]) => void;
            platform: NodeJS.Platform;
            shell: {
                open: (url: string) => Promise<void>;
            };
            clipboard: {
                writeText: (text: string) => Promise<void>;
            };
            checkForUpdates: () => Promise<any>;
            installUpdate: () => Promise<any>;
            killServer: () => Promise<any>;
            denshiSettings: {
                get: () => Promise<DenshiSettings>;
                set: (settings: DenshiSettings) => Promise<DenshiSettings>;
            };
            cast?: {
                discover: () => Promise<void>;
                stopDiscovery: () => Promise<void>;
                getDevices: () => Promise<CastDevice[]>;
                connect: (deviceId: string) => Promise<CastSessionState>;
                disconnect: () => Promise<void>;
                getStatus: () => Promise<CastStatus>;
                loadMedia: (opts: CastLoadMediaOptions) => Promise<number>;
                play: () => Promise<void>;
                pause: () => Promise<void>;
                seek: (time: number) => Promise<void>;
                stop: () => Promise<void>;
                setVolume: (level: number) => Promise<void>;
                setMuted: (muted: boolean) => Promise<void>;
                sendSubtitleEvents: (events: any[]) => Promise<void>;
                sendSubtitleTracks: (tracks: any[]) => Promise<void>;
                switchSubtitleTrack: (trackNumber: number) => Promise<void>;
                sendFonts: (fontUrls: string[], serverPort?: number) => Promise<void>;
                sendSubtitleHeader: (header: string) => Promise<void>;
                disableSubtitles: () => Promise<void>;
                getLanIP: () => Promise<string>;
            };
            // Client-side mpv (Denshi spawns mpv.exe locally, bridges its
            // JSON-IPC pipe to the renderer). Used to make mpv playback
            // work when the seanime server runs on a remote host (Unraid /
            // Docker) where the existing server-side mpv module has no
            // display to render onto. See seanime-denshi/src/mpv-client.js.
            mpv?: {
                available: (override?: string) => Promise<{ found: boolean; path: string | null; source: string | null; error?: string }>;
                launch: (opts: ClientMpvLaunchOptions) => Promise<{ ok: boolean; ipcPath?: string; mpvPath?: string; error?: string }>;
                kill: () => Promise<{ ok: boolean; killed: boolean }>;
                command: (cmd: any[]) => Promise<{ ok: boolean; data?: any; error?: string }>;
                seek: (time: number, mode?: "absolute" | "relative" | "absolute-percent") => Promise<{ ok: boolean; error?: string }>;
                setProperty: (name: string, value: any) => Promise<{ ok: boolean; data?: any; error?: string }>;
            };
        };

        __isElectronDesktop__?: boolean;
    }

    interface ClientMpvPlaylistItem {
        // Fully-built HTTP URL for this episode (path + HMAC token).
        url: string;
        // AniList media id for the entry this episode belongs to. Same
        // for every item in a single-series playlist.
        mediaId: number;
        // Episode's progress number (1-based). Used to re-key manual
        // tracking when mpv auto-advances.
        episodeNumber: number;
        // Server-side library path; surfaced back so continuity writes
        // can record `filepath` accurately for the now-playing item.
        filePath: string;
        // Display title (anime + episode) for OSD / window-title swap
        // when the item becomes active.
        fileTitle: string;
    }

    interface ClientMpvLaunchOptions {
        // HTTP URL mpv should open. Built by the renderer from the seanime
        // /api/v1/mediastream/file?path=... endpoint plus an HMAC token
        // when the server has a password configured.
        url: string;
        // Forced media title shown in mpv's window / OSD. Usually the
        // anime title + episode number so the user can tell which file
        // they're on at a glance.
        title?: string;
        // Resume position in seconds (server's last-known progress for
        // this episode). mpv jumps here on start; skipped when < ~5s.
        savedPosition?: number;
        // External subtitle files to pre-attach (server-extracted .ass
        // files etc). Each entry: { url, title?, lang? }.
        externalSubtitles?: Array<{ url: string; title?: string; lang?: string }>;
        // Extra mpv args appended verbatim. From settings.
        mpvArgs?: string;
        // Override path to mpv.exe; falls back to PATH / well-known
        // locations when unset.
        mpvPath?: string;
        // Sibling episodes to push into mpv's playlist after launch so
        // < / > keys and the OSC next/prev buttons can navigate to the
        // surrounding episodes. The item at `playlistStartIndex`
        // corresponds to `url` above.
        playlist?: ClientMpvPlaylistItem[];
        playlistStartIndex?: number;
    }

    interface ClientMpvState {
        timePos: number;
        duration: number;
        paused: boolean;
        eofReached: boolean;
        mediaTitle: string | null;
        tracks: any[];
    }

    interface ClientMpvExitedInfo {
        code: number;
        signal?: string;
        error?: string;
        completedNaturally: boolean;
    }

    interface ClientMpvPlaylistChangedInfo {
        // 0-based playlist index mpv moved FROM (the prior active item).
        from: number;
        // 0-based playlist index mpv moved TO (the new active item).
        to: number;
        // The renderer-provided metadata for the new item, or null if
        // mpv moved to an index outside the known playlist (shouldn't
        // happen but guarded against).
        item: ClientMpvPlaylistItem | null;
    }

    interface CastDevice {
        id: string;
        name: string;
        host: string;
        port: number;
    }

    interface CastSessionState {
        connected: boolean;
        device: CastDevice | null;
        sessionId: string | null;
    }

    interface CastStatus {
        connected: boolean;
        device: CastDevice | null;
        sessionId: string | null;
        mediaStatus: CastMediaStatus | null;
    }

    interface CastMediaStatus {
        mediaSessionId: number;
        playerState: "IDLE" | "BUFFERING" | "PLAYING" | "PAUSED";
        currentTime: number;
        duration?: number;
        volume?: { level: number; muted: boolean };
        idleReason?: string;
    }

    interface CastLoadMediaOptions {
        streamUrl: string;
        contentType: string;
        title?: string;
        subtitle?: string;
        imageUrl?: string;
        duration?: number;
        serverPort?: number;
    }

    interface DenshiSettings {
        minimizeToTray: boolean;
        openInBackground: boolean;
        openAtLaunch: boolean;
        updateChannel?: string;
    }
}
