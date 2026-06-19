// mpv-client.js
//
// Client-side mpv lifecycle controller for Denshi. Spawns a local mpv.exe
// process with a JSON-IPC named pipe (Windows) / unix socket (other OSes),
// then talks to mpv over that pipe so the renderer can observe progress,
// drive seeks, swap audio/subtitle tracks, and react to playback ending.
//
// The server-side mpv module in `internal/mediaplayers/mpv/` does the same
// thing but spawns mpv on whatever box runs the Go server. That doesn't
// help users who run Denshi against a remote (Unraid Docker) seanime
// server: there's no display attached to the Docker container. This module
// closes that gap by moving the mpv lifecycle into Denshi so playback
// happens on the user's actual desktop while progress / tracks / intro-skip
// are still wired through the same seanime UI and AniList sync flow.
//
// Only one mpv session is active at a time. Re-launching kills the prior
// process before spawning the new one. The renderer is notified of state
// changes and EOF via main-process IPC events (see main.js).
//
// References (mpv 0.41 IPC protocol):
//   https://mpv.io/manual/stable/#json-ipc

const { spawn } = require("child_process")
const net = require("net")
const fs = require("fs")
const path = require("path")
const os = require("os")
// electron-log v5 splits into main/renderer entry points; use the main
// variant explicitly to match the rest of Denshi (main.js loads
// "electron-log/main").
const log = require("electron-log/main")

// Where mpv should drop screenshots. By default mpv writes to its CWD,
// which for us is whatever directory Denshi was launched from (usually
// the install dir under Program Files / %LOCALAPPDATA%\Programs — often
// read-only, and not a place users want screenshot files scattered).
// Resolve a per-user "Pictures/seanime" folder and create it on first
// use so mpv's `s` / `S` keybinds always have a writable target.
// Returns null on any error so the caller can skip the arg and let mpv
// fall back to its default behaviour instead of failing outright.
function resolveScreenshotDir() {
    try {
        const dir = path.join(os.homedir(), "Pictures", "seanime")
        fs.mkdirSync(dir, { recursive: true })
        return dir
    } catch {
        return null
    }
}

// Where Windows users typically install mpv. We pick the first that
// exists; PATH lookup ("mpv") is tried before any of these so PATH wins
// when both are present.
const WINDOWS_MPV_CANDIDATES = [
    "mpv",
    "C:\\ProgramData\\chocolatey\\lib\\mpvio.install\\tools\\mpv.exe",
    "C:\\Program Files\\mpv\\mpv.exe",
    "C:\\Program Files (x86)\\mpv\\mpv.exe",
    "C:\\tools\\mpv\\mpv.exe",
]

const POSIX_MPV_CANDIDATES = [
    "mpv",
    "/usr/local/bin/mpv",
    "/usr/bin/mpv",
    "/opt/homebrew/bin/mpv",
]

function getMpvCandidates() {
    return process.platform === "win32" ? WINDOWS_MPV_CANDIDATES : POSIX_MPV_CANDIDATES
}

// Probe the candidate list and return the first usable mpv binary. The
// bare name "mpv" is resolved by exec via PATH; absolute paths are
// existence-checked first. Caches the result so repeated calls don't
// re-spawn mpv just to read --version.
let cachedDetection = null
function detectMpvPath(override) {
    if (override && typeof override === "string" && override.trim().length > 0) {
        const trimmed = override.trim()
        if (probeMpvBinary(trimmed)) {
            return { found: true, path: trimmed, source: "override" }
        }
    }
    if (cachedDetection) return cachedDetection

    for (const candidate of getMpvCandidates()) {
        if (probeMpvBinary(candidate)) {
            cachedDetection = { found: true, path: candidate, source: candidate === "mpv" ? "PATH" : "wellknown" }
            return cachedDetection
        }
    }
    cachedDetection = { found: false, path: null, source: null }
    return cachedDetection
}

function probeMpvBinary(candidate) {
    try {
        // Absolute path: existence check (fast, no process spawn).
        if (path.isAbsolute(candidate)) {
            return fs.existsSync(candidate)
        }
        // Bare name: rely on the OS PATH resolver via spawnSync --version.
        // Synchronous spawn is acceptable here because detection runs once
        // per Denshi launch (cached) and mpv --version exits in <50ms.
        const { spawnSync } = require("child_process")
        const r = spawnSync(candidate, ["--version"], { timeout: 2000, windowsHide: true })
        return r.status === 0
    } catch {
        return false
    }
}

// Generate an IPC endpoint path for this mpv instance. On Windows mpv
// expects a named pipe under \\.\pipe\ ; on other platforms it's a Unix
// socket path. The token includes pid+timestamp to keep concurrent
// Denshi launches (rare) from colliding.
function makeIpcPath() {
    const token = `${process.pid}-${Date.now()}`
    if (process.platform === "win32") {
        return `\\\\.\\pipe\\seanime-mpv-${token}`
    }
    return path.join(require("os").tmpdir(), `seanime-mpv-${token}.sock`)
}

class MpvSession {
    constructor({ mpvPath, url, title, savedPosition, externalSubtitles, mpvArgs, playlist, playlistStartIndex, onState, onExited, onPlaylistChanged, onLog }) {
        this.mpvPath = mpvPath
        this.url = url
        this.title = title || null
        this.savedPosition = typeof savedPosition === "number" ? savedPosition : null
        this.externalSubtitles = Array.isArray(externalSubtitles) ? externalSubtitles : []
        this.userMpvArgs = typeof mpvArgs === "string" ? mpvArgs.split(/\s+/).filter(Boolean) : []
        // Optional sibling-episode playlist: array of { url, ... } items.
        // mpv plays opts.url first (with --start applied), then we use IPC
        // to extend the playlist in both directions so mpv's < / > buttons
        // can navigate to neighbouring episodes. playlistStartIndex says
        // which entry corresponds to opts.url (so prior items are
        // "previous", later items are "next").
        this.playlist = Array.isArray(playlist) ? playlist : []
        this.playlistStartIndex = typeof playlistStartIndex === "number" && playlistStartIndex >= 0
            ? playlistStartIndex
            : 0
        // Current playlist position (0-based) in mpv's view. Starts at
        // 0 because mpv launches with a single-item playlist (just
        // opts.url) — its own playlist-pos really is 0 until we start
        // inserting items. populatePlaylist() suppresses the
        // playlist-pos handler while it runs and reads the
        // authoritative value back from mpv when it finishes, so this
        // ends up matching whatever final position mpv lands on (=
        // playlistStartIndex once all the insert-at 0 calls have
        // shifted the currently-playing item forward).
        this.currentPlaylistIndex = 0
        // True while populatePlaylist is in flight. mpv emits
        // playlist-pos property-change events as items are inserted in
        // front of the currently-playing one, but those aren't real
        // navigation — just bookkeeping. The handler treats them as
        // user-driven seeks otherwise, which was firing
        // setProperty("force-media-title", playlist[1].fileTitle)
        // because the response/event ordering on the IPC socket isn't
        // guaranteed and the property-change can land before the
        // sendCommand's own promise resolves.
        this.populating = false
        this.onState = onState || (() => {})
        this.onExited = onExited || (() => {})
        this.onPlaylistChanged = onPlaylistChanged || (() => {})
        this.onLog = onLog || (() => {})

        this.ipcPath = makeIpcPath()
        this.proc = null
        this.socket = null
        // Buffer accumulator for newline-delimited JSON over the IPC pipe.
        this.recvBuf = ""
        // Track requests so we can match responses to their command IDs and
        // resolve the corresponding promise. mpv numbers responses with the
        // request_id we send.
        this.nextRequestId = 1
        this.pendingRequests = new Map()
        // Last-known state surfaced to the renderer. We coalesce
        // property-change events into one snapshot rather than firing on
        // every property tick.
        this.state = {
            timePos: 0,
            duration: 0,
            paused: false,
            eofReached: false,
            mediaTitle: null,
            tracks: [],
        }
        // The renderer asks for the current snapshot when subscribing; we
        // also push updates on a short throttle (every ~1s) so progress
        // syncs don't hammer the WebSocket.
        this.lastEmittedAt = 0
        this.connected = false
        this.killed = false
    }

    async start() {
        const args = [
            this.url,
            `--input-ipc-server=${this.ipcPath}`,
            "--force-window=immediate",
            "--keep-open=yes",
            ...this.userMpvArgs,
        ]
        // Point mpv at a writable screenshot directory so `s` / `S`
        // (and `Shift+s` for "no subs") don't fail with "Error writing
        // screenshot" when mpv's CWD is Denshi's install dir.
        const screenshotDir = resolveScreenshotDir()
        if (screenshotDir) {
            args.push(`--screenshot-directory=${screenshotDir}`)
        }
        if (this.title) {
            args.push(`--force-media-title=${this.title}`)
            // Use mpv's property expansion in the window title so it
            // follows media-title automatically. We update
            // force-media-title via IPC when the playlist advances
            // (see the playlist-pos handler in handleIpcMessage); this
            // template ensures the OS window title picks that up too.
            // The literal "${media-title}" must be preserved verbatim
            // for mpv to expand — use a regular string, not a JS
            // template literal.
            args.push("--title=${media-title} - mpv (seanime)")
        }
        if (this.savedPosition !== null && this.savedPosition > 5) {
            // mpv accepts --start=<seconds>. Skip the resume if it's very
            // close to the start to avoid the "did I really seek?" jank.
            args.push(`--start=${this.savedPosition}`)
        }
        for (const sub of this.externalSubtitles) {
            // Each entry: { url, title?, lang? }. We pass via --sub-file so
            // mpv loads it during init; per-track metadata is added once
            // the IPC is up via `sub-add` (so we can also set the title).
            if (sub && typeof sub.url === "string") {
                args.push(`--sub-file=${sub.url}`)
            }
        }

        this.onLog("info", `spawning mpv: ${this.mpvPath} ${args.join(" ")}`)
        this.proc = spawn(this.mpvPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: false,
        })

        this.proc.stdout.on("data", (chunk) => this.onLog("stdout", chunk.toString()))
        this.proc.stderr.on("data", (chunk) => this.onLog("stderr", chunk.toString()))

        this.proc.on("error", (err) => {
            this.onLog("error", `spawn error: ${err.message}`)
            this.onExited({ code: -1, error: err.message, completedNaturally: false })
        })

        this.proc.on("exit", (code, signal) => {
            this.onLog("info", `mpv exited code=${code} signal=${signal}`)
            // EOF set before exit means natural completion (user watched to
            // the end). If mpv was killed externally or closed mid-stream
            // the eof flag stays false.
            const completedNaturally = this.state.eofReached
            this.cleanupSocket()
            this.onExited({ code: code ?? -1, signal, completedNaturally })
        })

        // The IPC socket isn't ready immediately after spawn — mpv binds
        // it asynchronously during startup. Retry with backoff until the
        // pipe accepts a connection or we hit a hard timeout.
        await this.connectWithRetry(8, 250)
        if (!this.connected) {
            this.onLog("warn", "mpv IPC connect timed out; killing")
            this.kill()
            throw new Error("mpv started but its IPC socket did not become ready")
        }
        await this.setupObservers()
    }

    async connectWithRetry(attempts, delayMs) {
        for (let i = 0; i < attempts; i++) {
            try {
                await this.connect()
                this.connected = true
                return
            } catch (err) {
                if (this.killed) return
                if (i === attempts - 1) {
                    this.onLog("warn", `final IPC connect failed: ${err.message}`)
                    return
                }
                await new Promise((r) => setTimeout(r, delayMs))
            }
        }
    }

    connect() {
        return new Promise((resolve, reject) => {
            const sock = net.createConnection(this.ipcPath)
            const onConnect = () => {
                sock.removeListener("error", onError)
                this.socket = sock
                this.attachSocketHandlers()
                resolve()
            }
            const onError = (err) => {
                sock.removeListener("connect", onConnect)
                try { sock.destroy() } catch {}
                reject(err)
            }
            sock.once("connect", onConnect)
            sock.once("error", onError)
        })
    }

    attachSocketHandlers() {
        this.socket.on("data", (chunk) => {
            this.recvBuf += chunk.toString("utf8")
            let nl
            // mpv sends one JSON object per line. Process every complete
            // line and keep any trailing partial in the buffer.
            while ((nl = this.recvBuf.indexOf("\n")) >= 0) {
                const line = this.recvBuf.slice(0, nl).trim()
                this.recvBuf = this.recvBuf.slice(nl + 1)
                if (!line) continue
                this.handleIpcMessage(line)
            }
        })
        this.socket.on("close", () => {
            this.onLog("info", "mpv IPC socket closed")
        })
        this.socket.on("error", (err) => {
            this.onLog("warn", `mpv IPC socket error: ${err.message}`)
        })
    }

    handleIpcMessage(line) {
        let msg
        try {
            msg = JSON.parse(line)
        } catch {
            return
        }

        // Response to a command we sent.
        if (msg.request_id && this.pendingRequests.has(msg.request_id)) {
            const { resolve, reject } = this.pendingRequests.get(msg.request_id)
            this.pendingRequests.delete(msg.request_id)
            if (msg.error === "success") resolve(msg.data)
            else reject(new Error(msg.error || "unknown mpv error"))
            return
        }

        // Property-change event (we asked for these via observe_property).
        if (msg.event === "property-change") {
            switch (msg.name) {
                case "time-pos":
                    this.state.timePos = typeof msg.data === "number" ? msg.data : 0
                    break
                case "duration":
                    this.state.duration = typeof msg.data === "number" ? msg.data : 0
                    break
                case "pause":
                    this.state.paused = !!msg.data
                    break
                case "eof-reached":
                    this.state.eofReached = !!msg.data
                    break
                case "media-title":
                    this.state.mediaTitle = typeof msg.data === "string" ? msg.data : null
                    break
                case "track-list":
                    this.state.tracks = Array.isArray(msg.data) ? msg.data : []
                    break
                case "playlist-pos":
                    if (typeof msg.data === "number" && msg.data >= 0) {
                        if (this.populating) {
                            // Track mpv's authoritative position
                            // silently — events during populate are
                            // just side-effects of insert-at 0, not
                            // real navigation. Skip the title rewrite
                            // and the onPlaylistChanged emit.
                            this.currentPlaylistIndex = msg.data
                            break
                        }
                        if (msg.data !== this.currentPlaylistIndex) {
                            const prev = this.currentPlaylistIndex
                            this.currentPlaylistIndex = msg.data
                            const item = this.playlist[msg.data] || null
                            // Push the new episode's title into mpv so
                            // the window title (via the ${media-title}
                            // template in --title) and the OSC's
                            // "currently playing" label both reflect
                            // the now-playing item instead of staying
                            // stuck on whatever we launched with.
                            // force-media-title is sticky for the
                            // session, so it has to be explicitly
                            // rewritten every time we advance.
                            if (item && item.fileTitle) {
                                this.setProperty("force-media-title", item.fileTitle).catch((err) => {
                                    this.onLog("warn", `failed to update force-media-title: ${err.message}`)
                                })
                            }
                            this.onPlaylistChanged({
                                from: prev,
                                to: msg.data,
                                item,
                            })
                        }
                    }
                    break
            }
            this.maybeEmitState()
            return
        }

        // Lifecycle events: end-file fires when mpv finishes playback
        // (reason 'eof') or when it's stopped externally.
        if (msg.event === "end-file") {
            if (msg.reason === "eof") {
                this.state.eofReached = true
                this.maybeEmitState(true)
            }
        }
    }

    maybeEmitState(force) {
        const now = Date.now()
        if (!force && now - this.lastEmittedAt < 1000) return
        this.lastEmittedAt = now
        this.onState({ ...this.state })
    }

    async setupObservers() {
        // Property change subscriptions. The ID per property is mpv's
        // local identifier for that observer; we use sequential ints
        // starting at 100 so they can't collide with regular request_ids.
        await this.sendCommand(["observe_property", 101, "time-pos"])
        await this.sendCommand(["observe_property", 102, "duration"])
        await this.sendCommand(["observe_property", 103, "pause"])
        await this.sendCommand(["observe_property", 104, "eof-reached"])
        await this.sendCommand(["observe_property", 105, "media-title"])
        await this.sendCommand(["observe_property", 106, "track-list"])
        // playlist-pos is what changes when mpv auto-advances to the
        // next item or when the user hits < / > in the OSC. We watch it
        // so we can re-key the renderer's "currently playing" session
        // to the right episode for progress / continuity attribution.
        await this.sendCommand(["observe_property", 107, "playlist-pos"])
        // Extend mpv's single-item playlist with the surrounding
        // episodes (if any were provided). Done after observers are
        // installed so we can see the playlist-pos updates that mpv
        // emits as items are inserted/appended.
        await this.populatePlaylist()
        // Pump an initial snapshot to the renderer so the UI doesn't
        // wait up to 1 second for the first property tick.
        this.maybeEmitState(true)
    }

    async populatePlaylist() {
        if (this.playlist.length <= 1) return

        // Flag the handler to suppress events fired during populate.
        // mpv emits a playlist-pos change for every insert-at 0 (the
        // currently-playing item gets shifted forward), but those
        // aren't real navigation — they're an implementation detail.
        // Without this guard the response/event order on the IPC
        // socket is racy: if the property-change is dispatched before
        // sendCommand's own response, the handler treats the very
        // first insert as a user seek to index 1 and overwrites the
        // window/OSC title with playlist[1].fileTitle (i.e. ep2 when
        // launching ep8). See the playlist-pos branch in
        // handleIpcMessage for the suppressed path.
        this.populating = true
        try {
            // Previous episodes (everything before playlistStartIndex).
            // Walk from closest-prev outward and insert each at
            // position 0 so the final order ends up
            // [earliest, ..., prev1, current, ...]. mpv shifts the
            // playing item's index forward on each insert; the handler
            // tracks that silently while populating == true.
            for (let i = this.playlistStartIndex - 1; i >= 0; i--) {
                const item = this.playlist[i]
                if (!item || typeof item.url !== "string") continue
                try {
                    await this.sendCommand(["loadfile", item.url, "insert-at", 0])
                } catch (err) {
                    this.onLog("warn", `failed to insert previous playlist item ${i}: ${err.message}`)
                }
            }

            // Next episodes (everything after playlistStartIndex).
            // Plain append — mpv puts them at the end of the playlist
            // in order and doesn't shift the playing item's position.
            for (let i = this.playlistStartIndex + 1; i < this.playlist.length; i++) {
                const item = this.playlist[i]
                if (!item || typeof item.url !== "string") continue
                try {
                    await this.sendCommand(["loadfile", item.url, "append"])
                } catch (err) {
                    this.onLog("warn", `failed to append next playlist item ${i}: ${err.message}`)
                }
            }
        } finally {
            this.populating = false
        }

        // Read mpv's authoritative playlist-pos and re-anchor our
        // tracker. The silent-update branch in handleIpcMessage
        // already kept currentPlaylistIndex in step with mpv during
        // populate, but if any property-change event got missed
        // (rare, but possible if mpv batched it differently or the
        // socket dropped) this round-trip guarantees we're in sync
        // before the user can interact with < / >.
        try {
            const pos = await this.sendCommand(["get_property", "playlist-pos"])
            if (typeof pos === "number" && pos >= 0) {
                this.currentPlaylistIndex = pos
            }
        } catch (err) {
            this.onLog("warn", `failed to read final playlist-pos: ${err.message}`)
        }
    }

    sendCommand(cmd) {
        return new Promise((resolve, reject) => {
            if (!this.socket || this.killed) {
                reject(new Error("mpv socket not connected"))
                return
            }
            const id = this.nextRequestId++
            const payload = JSON.stringify({ command: cmd, request_id: id }) + "\n"
            this.pendingRequests.set(id, { resolve, reject })
            // Safety net: drop a request after 5 seconds so a hung mpv
            // doesn't leak the entry forever.
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id)
                    reject(new Error("mpv command timed out"))
                }
            }, 5000)
            this.socket.write(payload)
        })
    }

    async seek(seconds, mode) {
        // mode: "absolute" (default) | "relative" | "absolute-percent"
        return this.sendCommand(["seek", seconds, mode || "absolute"])
    }

    async setPaused(paused) {
        return this.sendCommand(["set_property", "pause", !!paused])
    }

    async setProperty(name, value) {
        return this.sendCommand(["set_property", name, value])
    }

    async runCommand(cmd) {
        // Pass-through escape hatch for cases the renderer needs but the
        // higher-level helpers above don't cover yet. cmd is a JS array
        // matching mpv's documented command list format.
        return this.sendCommand(cmd)
    }

    cleanupSocket() {
        if (this.socket) {
            try { this.socket.destroy() } catch {}
            this.socket = null
        }
        this.pendingRequests.forEach(({ reject }) => {
            try { reject(new Error("mpv session ended")) } catch {}
        })
        this.pendingRequests.clear()
    }

    kill() {
        this.killed = true
        this.cleanupSocket()
        if (this.proc && this.proc.exitCode === null) {
            try { this.proc.kill() } catch {}
        }
        this.proc = null
    }
}

let activeSession = null

function getActiveSession() {
    return activeSession
}

async function launchMpv(opts) {
    // Replace any in-flight session. Re-launch is the user's chosen action
    // (clicking "Play with mpv" again on a different episode), so killing
    // the prior process is the expected behavior.
    if (activeSession) {
        activeSession.kill()
        activeSession = null
    }

    const detection = detectMpvPath(opts.mpvPathOverride)
    if (!detection.found) {
        throw new Error("mpv binary not found. Install mpv or set a custom path in Denshi settings.")
    }

    const session = new MpvSession({
        mpvPath: detection.path,
        url: opts.url,
        title: opts.title,
        savedPosition: opts.savedPosition,
        externalSubtitles: opts.externalSubtitles || [],
        mpvArgs: opts.mpvArgs || "",
        playlist: opts.playlist || [],
        playlistStartIndex: opts.playlistStartIndex,
        onState: opts.onState,
        onExited: (info) => {
            if (activeSession === session) activeSession = null
            if (opts.onExited) opts.onExited(info)
        },
        onPlaylistChanged: opts.onPlaylistChanged,
        onLog: opts.onLog,
    })
    activeSession = session

    try {
        await session.start()
    } catch (err) {
        if (activeSession === session) activeSession = null
        throw err
    }
    return { ipcPath: session.ipcPath, mpvPath: detection.path }
}

function killActive() {
    if (activeSession) {
        activeSession.kill()
        activeSession = null
        return true
    }
    return false
}

module.exports = {
    detectMpvPath,
    launchMpv,
    killActive,
    getActiveSession,
}
