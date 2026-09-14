import { logger } from "@/lib/helpers/debug"
import { atomWithStorage } from "jotai/utils"

const log = logger("CLIENT MPV ANIME4K")

/**
 * Anime4K for client-side mpv (Denshi).
 *
 * Denshi downloads the official Anime4K GLSL pack (pinned release) into its
 * user-data dir and generates an mpv keybinding script — see
 * seanime-denshi/src/anime4k.js. This module holds the renderer-side state:
 * the default mode applied at launch (per device) and the helper that turns
 * it into launch options. In-player, CTRL+1..6 switch modes and CTRL+0
 * turns Anime4K off regardless of the default chosen here.
 */

export type ClientMpvAnime4kMode =
    "off"
    | "hq-a" | "hq-b" | "hq-c" | "hq-aa" | "hq-bb" | "hq-ca"
    | "fast-a" | "fast-b" | "fast-c" | "fast-aa" | "fast-bb" | "fast-ca"
    | "cnn-2x-m" | "cnn-2x-vl" | "cnn-2x-ul" | "denoise-cnn-2x-vl"

export const __clientMpv_anime4kModeAtom = atomWithStorage<ClientMpvAnime4kMode>(
    "sea-client-mpv-anime4k-mode",
    "off",
    undefined,
    { getOnInit: true },
)

export const CLIENT_MPV_ANIME4K_OPTIONS: { value: ClientMpvAnime4kMode; label: string }[] = [
    { value: "off", label: "Off by default (switch in mpv: CTRL+a menu, CTRL+1-6)" },
    { value: "hq-a", label: "Mode A (HQ) — restore + upscale" },
    { value: "hq-b", label: "Mode B (HQ) — soft restore + upscale" },
    { value: "hq-c", label: "Mode C (HQ) — denoising upscale" },
    { value: "hq-aa", label: "Mode A+A (HQ) — max line reconstruction" },
    { value: "hq-bb", label: "Mode B+B (HQ) — double soft restore" },
    { value: "hq-ca", label: "Mode C+A (HQ) — denoise + restore" },
    { value: "fast-a", label: "Mode A (Fast) — for weaker GPUs" },
    { value: "fast-b", label: "Mode B (Fast)" },
    { value: "fast-c", label: "Mode C (Fast)" },
    { value: "fast-aa", label: "Mode A+A (Fast)" },
    { value: "fast-bb", label: "Mode B+B (Fast)" },
    { value: "fast-ca", label: "Mode C+A (Fast)" },
    { value: "cnn-2x-m", label: "CNN 2x M — raw upscaler, balanced" },
    { value: "cnn-2x-vl", label: "CNN 2x VL — raw upscaler, high quality" },
    { value: "cnn-2x-ul", label: "CNN 2x UL — raw upscaler, max quality" },
    { value: "denoise-cnn-2x-vl", label: "Denoise CNN 2x VL — for noisy sources" },
]

/**
 * Resolves the Anime4K launch wiring for the given default mode.
 * Returns undefined outside Denshi, when the shaders aren't installed, or
 * on any bridge error — mpv then launches without Anime4K, never blocked by it.
 */
export async function getClientMpvAnime4kLaunch(mode: ClientMpvAnime4kMode): Promise<ClientMpvLaunchOptions["anime4k"] | undefined> {
    const bridge = typeof window !== "undefined" ? window.electron?.anime4k : undefined
    if (!bridge) return undefined

    try {
        const status = await bridge.status()
        if (!status.ok || !status.installed) return undefined

        const res = await bridge.resolve(mode)
        if (!res.ok || !res.luaPath) {
            if (res.error) log.warning("Failed to resolve Anime4K mode", res.error)
            return undefined
        }

        return { luaPath: res.luaPath, tier: res.tier || "hq", shaderArg: res.shaderArg ?? null }
    }
    catch (error: unknown) {
        log.error("Anime4K bridge error", error)
        return undefined
    }
}
