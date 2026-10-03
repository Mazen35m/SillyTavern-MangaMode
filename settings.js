import { ensureProfiles } from './model-profiles.js';

export const EXTENSION_NAME = 'third-party/SillyTavern-MangaMode';
export const MODULE_KEY = 'mangaMode';

/**
 * Which field of the parsed scene the prompt builder uses, and how it's combined with the
 * per-style prefix/suffix. Switching image model families is then just switching this setting -
 * no code change needed, since the scene parser always outputs all fields.
 */
export const PROMPT_STYLES = {
    TAGS: 'tags',
    TAGS_PONY: 'tags_pony',
    NATURAL: 'natural',
};

export const DEFAULT_SETTINGS = {
    enabled: false,
    autoGenerate: true,
    revealTextByDefault: false,
    showSpeechBubbles: true,
    debug: false,
    connectionProfileId: '',
    maxPanels: 6,
    /**
     * A vision model checks every finished picture against its frame (missing/doubled figures,
     * wrong outfit, lettering, broken anatomy) and it is redrawn up to `maxRedraws` times. The same
     * check finds the heads that close-ups are cut to and balloons keep clear of.
     */
    qualityCheck: true,
    /** Model for the check, used when the parser's Connection Profile goes through OpenRouter. */
    visionModel: 'google/gemini-3.8-flash',
    /** A failed quality check is confirmed by a second look at the same picture before a redraw (1.12). */
    confirmChecks: true,
    /** A hands insert that failed every look is redrawn once as a medium shot of the person (1.13). */
    insertFallback: true,
    maxRedraws: 2,
    /** Draw with a workflow saved in ComfyUI (needs the ComfyUI-MangaMode-Bridge add-on). userChoice: the user picked (or declined) one by hand, so none is picked for them. */
    customWorkflow: { enabled: false, name: '', userChoice: false },
    // How strongly an IP-Adapter in a custom workflow follows the character sheet: 0.6 keeps the
    // face, hair and clothes; 0.8+ starts copying the sheet's pose and background too (tested).
    ipAdapterStrength: 0.6,
    // Two or more people in a frame: each face is redrawn lightly from that person's reference.
    // Off by default: it helps a little and costs about a minute per page (two faces x four frames).
    faceTouchUp: false,
    /** Total ComfyUI images per reply, over all panels and their frames (crops are free, not counted). */
    maxImages: 10,
    /** Let the parser add short, clearly marked inner-thought balloons (dotted) where the narration states a feeling. */
    innerThoughts: true,
    /** First-person mode: the player is never drawn - every frame is seen through the player's eyes. */
    playerPov: true,
    /**
     * Webtoon mode: one continuous vertical scroll instead of pages. Every beat is its own full-width picture,
     * stacked with a thin gap, no white page margins, no grid of frames; balloons stay on the pictures.
     */
    webtoonMode: false,
    /** Under each page: what its LLM calls cost (scene, world book, picture checks) and the chat's total. */
    showCost: true,
    // Crops (close-ups cut from a larger image) are re-drawn at full resolution with a light
    // img2img pass - sharper faces for a few seconds each. Needs ComfyUI-Easy-Use's base64 loader.
    detailPass: true,
    // Character reference (Anima-InContext-Character): each known character gets a reference sheet
    // once, and one-person frames showing them are drawn with it attached. Needs
    // comfyui-anima-incontext and the in-context LoRA in models/loras. Off by default: on Anima
    // Turbo it was only a small consistency gain for ~3x the time per frame, greyed the colours at
    // LoRA strength 1 and broke two-person frames (fixed-seed tests 2026-09-25; 0.5 keeps colours).
    characterReference: false,
    referenceLora: 'anima-incontext-character.safetensors',
    referenceLoraStrength: 0.5,
    referenceStrength: 1,
    referenceSheets: {},
    /** Hidden "thinking" the parser model may do: 'minimal' | 'low' | 'medium' | 'default' (send nothing). */
    parserReasoning: 'minimal',
    /** Minimum number of assistant messages between two full-bleed (peak) panels. */
    fullBleedCooldown: 10,
    /** A single-beat reply with this many dialogue lines is shown as a frame plus a closer crop. */
    splitDialogueThreshold: 5,
    /** Give the scene parser the player's last message + the previous reply's tail as context. */
    sceneContext: true,
    // Defaults match the tested setup: Anima Turbo v1.1 (files in DOWNLOADS.md). Other models: Advanced settings, or pick a saved model profile.
    promptStyle: PROMPT_STYLES.NATURAL,
    promptPresets: {
        [PROMPT_STYLES.TAGS]: {
            prefix: '',
            suffix: 'masterpiece, best quality, colored manhwa style, webtoon illustration, full color, clean digital lineart, cel shading, vibrant colors',
        },
        [PROMPT_STYLES.TAGS_PONY]: {
            prefix: 'score_9, score_8_up, score_7_up, score_6_up',
            suffix: 'colored manhwa style, webtoon illustration, full color, clean digital lineart, cel shading, vibrant colors',
        },
        [PROMPT_STYLES.NATURAL]: {
            prefix: 'masterpiece, best quality, score_7, A colored webtoon manhwa illustration.',
            suffix: 'Clean digital lineart, cel shading, vibrant full color.',
        },
    },
    /** Saved per-model bundles (model-profiles.js). The first one is created from the current settings. */
    modelProfiles: [],
    activeProfileId: '',
    comfy: {
        url: 'http://127.0.0.1:8188',
        /** Workflow family: 'checkpoint' (single file) or 'split' (diffusion model + text encoder + VAE). */
        family: 'split',
        checkpoint: '',
        /** 'split' family only. */
        unet: 'anima-turbo-v1.1.safetensors',
        unetDtype: 'default',
        clip: 'qwen_3_06b_base.safetensors',
        clipType: 'stable_diffusion',
        /** Optional separate VAE (required for 'split'; overrides the checkpoint's own VAE if set). */
        vae: 'qwen_image_vae.safetensors',
        /** Negative terms a specific model needs (e.g. Anima's score_1-3); set by its profile. */
        modelNegative: 'score_1, score_2, score_3',
        /** LoRAs chained on the model: "file.safetensors:0.8, other.safetensors" (models/loras). */
        loras: '',
        sampler: 'er_sde',
        scheduler: 'simple',
        steps: 10,
        cfg: 1,
        width: 896,
        height: 1152,
        /** Longest a single ComfyUI job may take before it is retried once. */
        timeoutSeconds: 300,
        negativePrompt: 'text, speech bubble, dialogue, subtitles, caption, watermark, signature, logo, monochrome, grayscale, screentone, sketch, extra limbs, extra fingers, bad anatomy, worst quality, low quality, jpeg artifacts, blurry',
    },
};

/**
 * Backfills any keys missing from `target` (in place) using `defaults`, one level deep.
 * @param {object} target
 * @param {object} defaults
 */
function backfill(target, defaults) {
    for (const key of Object.keys(defaults)) {
        if (target[key] === undefined) {
            target[key] = structuredClone(defaults[key]);
        }
    }
}

/**
 * Returns the persisted Manga Mode settings object, backfilling any missing defaults in place.
 * @param {object} extensionSettings The extension_settings object from SillyTavern.getContext().
 * @returns {typeof DEFAULT_SETTINGS} Manga Mode settings.
 */
export function getSettings(extensionSettings) {
    if (!extensionSettings[MODULE_KEY] || typeof extensionSettings[MODULE_KEY] !== 'object') {
        extensionSettings[MODULE_KEY] = structuredClone(DEFAULT_SETTINGS);
    }

    const settings = extensionSettings[MODULE_KEY];
    backfill(settings, DEFAULT_SETTINGS);
    // Switches of the old pipeline, replaced by the world book, cast book and quality check.
    for (const retired of ['appearanceCache', 'characterConsistency', 'visualDirector', 'speedMode', 'fullModeMa']) delete settings[retired];

    if (typeof settings.comfy !== 'object' || settings.comfy === null) {
        settings.comfy = structuredClone(DEFAULT_SETTINGS.comfy);
    } else {
        backfill(settings.comfy, DEFAULT_SETTINGS.comfy);
    }

    if (typeof settings.promptPresets !== 'object' || settings.promptPresets === null) {
        settings.promptPresets = structuredClone(DEFAULT_SETTINGS.promptPresets);
    } else {
        for (const style of Object.values(PROMPT_STYLES)) {
            if (typeof settings.promptPresets[style] !== 'object' || settings.promptPresets[style] === null) {
                settings.promptPresets[style] = structuredClone(DEFAULT_SETTINGS.promptPresets[style]);
            } else {
                backfill(settings.promptPresets[style], DEFAULT_SETTINGS.promptPresets[style]);
            }
        }
    }

    ensureProfiles(settings);
    return settings;
}

