// Anime4K shader support for client-side mpv.
//
// "Install" downloads the official Anime4K GLSL shaders (pinned to the
// v4.0.1 release of bloc97/Anime4K, MIT licensed) into <userData>/anime4k
// and generates a small Lua script that adds in-player controls:
//   CTRL+1..CTRL+6  switch between the six canonical modes (A, B, C, A+A,
//                   B+B, C+A) of the selected quality tier
//   CTRL+0          turn Anime4K off
//   CTRL+a          open a selector menu with every preset (uses mpv's
//                   built-in mp.input selector, same UI as the native
//                   g-t / g-a track menus; needs mpv 0.39+)
//
// Note: the GAN upscalers of the web player exist only in the WebGPU port,
// not as official mpv GLSL shaders — CNN 2x UL is the max-quality option here.
//
// Nothing here touches the user's global mpv configuration: the script and
// shaders are only handed to mpv instances Seanime launches, via
// --scripts-append / --script-opts-append / --glsl-shaders (see
// mpv-client.js). The mode chains mirror GLSL_Instructions.md at the
// pinned tag exactly.

const { app } = require("electron")
const fs = require("fs")
const path = require("path")
const log = require("electron-log/main")

const ANIME4K_TAG = "v4.0.1"
const RAW_BASE = `https://raw.githubusercontent.com/bloc97/Anime4K/${ANIME4K_TAG}/`
const LUA_FILENAME = "seanime_anime4k.lua"

// Shader file name -> path inside the Anime4K repository at ANIME4K_TAG.
const SHADER_FILES = {
    "Anime4K_Clamp_Highlights.glsl": "glsl/Restore/Anime4K_Clamp_Highlights.glsl",
    "Anime4K_Restore_CNN_VL.glsl": "glsl/Restore/Anime4K_Restore_CNN_VL.glsl",
    "Anime4K_Restore_CNN_M.glsl": "glsl/Restore/Anime4K_Restore_CNN_M.glsl",
    "Anime4K_Restore_CNN_S.glsl": "glsl/Restore/Anime4K_Restore_CNN_S.glsl",
    "Anime4K_Restore_CNN_Soft_VL.glsl": "glsl/Restore/Anime4K_Restore_CNN_Soft_VL.glsl",
    "Anime4K_Restore_CNN_Soft_M.glsl": "glsl/Restore/Anime4K_Restore_CNN_Soft_M.glsl",
    "Anime4K_Restore_CNN_Soft_S.glsl": "glsl/Restore/Anime4K_Restore_CNN_Soft_S.glsl",
    "Anime4K_Upscale_CNN_x2_VL.glsl": "glsl/Upscale/Anime4K_Upscale_CNN_x2_VL.glsl",
    "Anime4K_Upscale_CNN_x2_M.glsl": "glsl/Upscale/Anime4K_Upscale_CNN_x2_M.glsl",
    "Anime4K_Upscale_CNN_x2_S.glsl": "glsl/Upscale/Anime4K_Upscale_CNN_x2_S.glsl",
    "Anime4K_Upscale_CNN_x2_UL.glsl": "glsl/Upscale/Anime4K_Upscale_CNN_x2_UL.glsl",
    "Anime4K_Upscale_Denoise_CNN_x2_VL.glsl": "glsl/Upscale+Denoise/Anime4K_Upscale_Denoise_CNN_x2_VL.glsl",
    "Anime4K_Upscale_Denoise_CNN_x2_M.glsl": "glsl/Upscale+Denoise/Anime4K_Upscale_Denoise_CNN_x2_M.glsl",
    "Anime4K_AutoDownscalePre_x2.glsl": "glsl/Upscale/Anime4K_AutoDownscalePre_x2.glsl",
    "Anime4K_AutoDownscalePre_x4.glsl": "glsl/Upscale/Anime4K_AutoDownscalePre_x4.glsl",
}

// Official mode chains (GLSL_Instructions.md at ANIME4K_TAG).
// hq = the "higher-end GPU" chains, fast = the "lower-end GPU" chains.
const CHAINS = {
    hq: {
        a: ["Anime4K_Clamp_Highlights.glsl", "Anime4K_Restore_CNN_VL.glsl", "Anime4K_Upscale_CNN_x2_VL.glsl", "Anime4K_AutoDownscalePre_x2.glsl", "Anime4K_AutoDownscalePre_x4.glsl", "Anime4K_Upscale_CNN_x2_M.glsl"],
        b: ["Anime4K_Clamp_Highlights.glsl", "Anime4K_Restore_CNN_Soft_VL.glsl", "Anime4K_Upscale_CNN_x2_VL.glsl", "Anime4K_AutoDownscalePre_x2.glsl", "Anime4K_AutoDownscalePre_x4.glsl", "Anime4K_Upscale_CNN_x2_M.glsl"],
        c: ["Anime4K_Clamp_Highlights.glsl", "Anime4K_Upscale_Denoise_CNN_x2_VL.glsl", "Anime4K_AutoDownscalePre_x2.glsl", "Anime4K_AutoDownscalePre_x4.glsl", "Anime4K_Upscale_CNN_x2_M.glsl"],
        aa: ["Anime4K_Clamp_Highlights.glsl", "Anime4K_Restore_CNN_VL.glsl", "Anime4K_Upscale_CNN_x2_VL.glsl", "Anime4K_AutoDownscalePre_x2.glsl", "Anime4K_AutoDownscalePre_x4.glsl", "Anime4K_Restore_CNN_M.glsl", "Anime4K_Upscale_CNN_x2_M.glsl"],
        bb: ["Anime4K_Clamp_Highlights.glsl", "Anime4K_Restore_CNN_Soft_VL.glsl", "Anime4K_Upscale_CNN_x2_VL.glsl", "Anime4K_AutoDownscalePre_x2.glsl", "Anime4K_AutoDownscalePre_x4.glsl", "Anime4K_Restore_CNN_Soft_M.glsl", "Anime4K_Upscale_CNN_x2_M.glsl"],
        ca: ["Anime4K_Clamp_Highlights.glsl", "Anime4K_Upscale_Denoise_CNN_x2_VL.glsl", "Anime4K_AutoDownscalePre_x2.glsl", "Anime4K_AutoDownscalePre_x4.glsl", "Anime4K_Restore_CNN_M.glsl", "Anime4K_Upscale_CNN_x2_M.glsl"],
    },
    fast: {
        a: ["Anime4K_Clamp_Highlights.glsl", "Anime4K_Restore_CNN_M.glsl", "Anime4K_Upscale_CNN_x2_M.glsl", "Anime4K_AutoDownscalePre_x2.glsl", "Anime4K_AutoDownscalePre_x4.glsl", "Anime4K_Upscale_CNN_x2_S.glsl"],
        b: ["Anime4K_Clamp_Highlights.glsl", "Anime4K_Restore_CNN_Soft_M.glsl", "Anime4K_Upscale_CNN_x2_M.glsl", "Anime4K_AutoDownscalePre_x2.glsl", "Anime4K_AutoDownscalePre_x4.glsl", "Anime4K_Upscale_CNN_x2_S.glsl"],
        c: ["Anime4K_Clamp_Highlights.glsl", "Anime4K_Upscale_Denoise_CNN_x2_M.glsl", "Anime4K_AutoDownscalePre_x2.glsl", "Anime4K_AutoDownscalePre_x4.glsl", "Anime4K_Upscale_CNN_x2_S.glsl"],
        aa: ["Anime4K_Clamp_Highlights.glsl", "Anime4K_Restore_CNN_M.glsl", "Anime4K_Upscale_CNN_x2_M.glsl", "Anime4K_AutoDownscalePre_x2.glsl", "Anime4K_AutoDownscalePre_x4.glsl", "Anime4K_Restore_CNN_S.glsl", "Anime4K_Upscale_CNN_x2_S.glsl"],
        bb: ["Anime4K_Clamp_Highlights.glsl", "Anime4K_Restore_CNN_Soft_M.glsl", "Anime4K_Upscale_CNN_x2_M.glsl", "Anime4K_AutoDownscalePre_x2.glsl", "Anime4K_AutoDownscalePre_x4.glsl", "Anime4K_Restore_CNN_Soft_S.glsl", "Anime4K_Upscale_CNN_x2_S.glsl"],
        ca: ["Anime4K_Clamp_Highlights.glsl", "Anime4K_Upscale_Denoise_CNN_x2_M.glsl", "Anime4K_AutoDownscalePre_x2.glsl", "Anime4K_AutoDownscalePre_x4.glsl", "Anime4K_Restore_CNN_S.glsl", "Anime4K_Upscale_CNN_x2_S.glsl"],
    },
}

const MODE_ORDER = ["a", "b", "c", "aa", "bb", "ca"]
const MODE_NAMES = { a: "Mode A", b: "Mode B", c: "Mode C", aa: "Mode A+A", bb: "Mode B+B", ca: "Mode C+A" }

// Flat preset table: everything selectable from Seanime's settings and the
// in-mpv CTRL+a menu. Raw CNN presets mirror the web player's options
// (Clamp_Highlights first, per upstream guidance).
function buildPresets() {
    const presets = {}
    for (const tier of ["hq", "fast"]) {
        const tierName = tier === "hq" ? "HQ" : "Fast"
        for (const key of MODE_ORDER) {
            presets[`${tier}-${key}`] = {
                name: `${MODE_NAMES[key]} (${tierName})`,
                files: CHAINS[tier][key],
            }
        }
    }
    presets["cnn-2x-m"] = { name: "CNN 2x M", files: ["Anime4K_Clamp_Highlights.glsl", "Anime4K_Upscale_CNN_x2_M.glsl"] }
    presets["cnn-2x-vl"] = { name: "CNN 2x VL", files: ["Anime4K_Clamp_Highlights.glsl", "Anime4K_Upscale_CNN_x2_VL.glsl"] }
    presets["cnn-2x-ul"] = { name: "CNN 2x UL", files: ["Anime4K_Clamp_Highlights.glsl", "Anime4K_Upscale_CNN_x2_UL.glsl"] }
    presets["denoise-cnn-2x-vl"] = { name: "Denoise CNN 2x VL", files: ["Anime4K_Clamp_Highlights.glsl", "Anime4K_Upscale_Denoise_CNN_x2_VL.glsl"] }
    return presets
}

const PRESETS = buildPresets()

// Menu order for the in-mpv selector.
const PRESET_ORDER = [
    "hq-a", "hq-b", "hq-c", "hq-aa", "hq-bb", "hq-ca",
    "fast-a", "fast-b", "fast-c", "fast-aa", "fast-bb", "fast-ca",
    "cnn-2x-m", "cnn-2x-vl", "cnn-2x-ul", "denoise-cnn-2x-vl",
]

function getDir() {
    return path.join(app.getPath("userData"), "anime4k")
}

function getLuaPath() {
    return path.join(getDir(), LUA_FILENAME)
}

function listSeparator() {
    // mpv's path-list separator: ';' on Windows, ':' elsewhere
    return process.platform === "win32" ? ";" : ":"
}

function getStatus() {
    const dir = getDir()
    const missing = Object.keys(SHADER_FILES).filter((name) => !fs.existsSync(path.join(dir, name)))
    if (!fs.existsSync(getLuaPath())) missing.push(LUA_FILENAME)
    return { installed: missing.length === 0, dir, tag: ANIME4K_TAG, missing }
}

async function install() {
    const dir = getDir()
    fs.mkdirSync(dir, { recursive: true })

    for (const [name, repoPath] of Object.entries(SHADER_FILES)) {
        const url = RAW_BASE + repoPath
        log.info(`[anime4k] downloading ${name}`)
        const res = await fetch(url)
        if (!res.ok) {
            throw new Error(`failed to download ${name}: HTTP ${res.status}`)
        }
        const text = await res.text()
        // Every mpv hook shader carries //!HOOK directives; refuse to save
        // anything that doesn't look like one (e.g. an HTML error page).
        if (!text.includes("//!HOOK")) {
            throw new Error(`downloaded ${name} does not look like an mpv GLSL shader`)
        }
        // Write atomically so a mid-download failure never leaves a
        // truncated shader that mpv would then choke on.
        const tmp = path.join(dir, `${name}.tmp`)
        fs.writeFileSync(tmp, text, "utf-8")
        fs.renameSync(tmp, path.join(dir, name))
    }

    writeLuaScript()
    log.info(`[anime4k] installed ${Object.keys(SHADER_FILES).length} shaders (${ANIME4K_TAG}) to ${dir}`)
    return getStatus()
}

// Generates the in-player control script. The shader directory is baked in
// with forward slashes (mpv accepts them on Windows, avoids Lua escaping).
function writeLuaScript() {
    const shaderDir = getDir().replace(/\\/g, "/").replace(/\/+$/, "") + "/"
    const sep = listSeparator()

    const luaPreset = (id) => {
        const p = PRESETS[id]
        const files = p.files.map((f) => `"${f}"`).join(", ")
        return `    { id = "${id}", name = "${p.name}", files = { ${files} } },`
    }

    const lines = [
        `-- Generated by Seanime Denshi (Anime4K ${ANIME4K_TAG}).`,
        `-- Reinstalling Anime4K from Seanime's settings overwrites this file.`,
        `-- CTRL+1..6: modes A, B, C, A+A, B+B, C+A of the configured tier`,
        `-- CTRL+0: off  |  CTRL+a: preset selector menu (mpv 0.39+)`,
        `local options = require "mp.options"`,
        ``,
        `local SHADER_DIR = "${shaderDir}"`,
        `local SEP = "${sep}"`,
        ``,
        `local opts = { tier = "hq" }`,
        `options.read_options(opts, "seanime_anime4k")`,
        ``,
        `local PRESETS = {`,
        ...PRESET_ORDER.map(luaPreset),
        `}`,
        ``,
        `local function find_preset(id)`,
        `    for _, p in ipairs(PRESETS) do`,
        `        if p.id == id then return p end`,
        `    end`,
        `    return nil`,
        `end`,
        ``,
        `local MODE_KEYS = { "a", "b", "c", "aa", "bb", "ca" }`,
        ``,
        `local function tier()`,
        `    if opts.tier == "fast" then return "fast" end`,
        `    return "hq"`,
        `end`,
        ``,
        `local function apply(preset)`,
        `    local paths = {}`,
        `    for n, f in ipairs(preset.files) do paths[n] = SHADER_DIR .. f end`,
        `    mp.commandv("change-list", "glsl-shaders", "set", table.concat(paths, SEP))`,
        `    mp.osd_message("Anime4K: " .. preset.name)`,
        `end`,
        ``,
        `local function clear()`,
        `    mp.commandv("change-list", "glsl-shaders", "clr", "")`,
        `    mp.osd_message("Anime4K: off")`,
        `end`,
        ``,
        `local function open_menu()`,
        `    local ok, input = pcall(require, "mp.input")`,
        `    if not ok or not input.select then`,
        `        mp.osd_message("Anime4K menu requires mpv 0.39+ (use CTRL+0..6)")`,
        `        return`,
        `    end`,
        `    local items = { "Off" }`,
        `    for _, p in ipairs(PRESETS) do items[#items + 1] = p.name end`,
        `    input.select({`,
        `        prompt = "Anime4K:",`,
        `        items = items,`,
        `        submit = function(idx)`,
        `            if idx == 1 then clear() return end`,
        `            local p = PRESETS[idx - 1]`,
        `            if p then apply(p) end`,
        `        end,`,
        `    })`,
        `end`,
        ``,
        `for i = 1, 6 do`,
        `    mp.add_key_binding("ctrl+" .. i, "seanime-anime4k-mode-" .. i, function()`,
        `        local p = find_preset(tier() .. "-" .. MODE_KEYS[i])`,
        `        if p then apply(p) end`,
        `    end)`,
        `end`,
        `mp.add_key_binding("ctrl+0", "seanime-anime4k-off", clear)`,
        `mp.add_key_binding("ctrl+a", "seanime-anime4k-menu", open_menu)`,
        ``,
    ]

    fs.writeFileSync(getLuaPath(), lines.join("\n"), "utf-8")
}

// Removes the managed shader directory entirely (shaders + generated Lua).
// Only ever touches <userData>/anime4k, which this module fully owns.
function uninstall() {
    const dir = getDir()
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
        log.info(`[anime4k] uninstalled (removed ${dir})`)
    }
    return getStatus()
}

// mode: "off" or a PRESETS id (e.g. "hq-a", "fast-ca", "cnn-2x-ul").
// Returns what mpv-client.js needs to wire mpv up. "off" still returns the
// Lua path so the in-player keybindings and menu work from a disabled state.
function resolve(mode) {
    const status = getStatus()
    if (!status.installed) {
        throw new Error("Anime4K shaders are not installed")
    }

    const luaPath = getLuaPath()
    if (!mode || mode === "off") {
        return { luaPath, tier: "hq", shaderArg: null }
    }

    const preset = PRESETS[mode]
    if (!preset) {
        throw new Error(`unknown Anime4K mode: ${mode}`)
    }

    const tier = String(mode).startsWith("fast-") ? "fast" : "hq"
    const shaderArg = preset.files.map((f) => path.join(getDir(), f)).join(listSeparator())
    return { luaPath, tier, shaderArg }
}

module.exports = { getStatus, install, uninstall, resolve }
