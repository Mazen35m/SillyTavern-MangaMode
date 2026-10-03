// Model profiles: one saved bundle per image model - which workflow family loads it, its files,
// its sampler settings, which Prompt Style its text encoder needs, and any model-specific negative
// terms. A profile never contains prompt logic: it only SELECTS one of the existing Prompt Styles
// (settings.promptStyle + promptPresets), so switching model family stays a settings change.
//
// Applying a profile copies its values into the live settings (settings.comfy, settings.promptStyle),
// so the rest of the pipeline - and the per-message cache hash - keep reading the same fields.

export const WORKFLOW_FAMILIES = {
    /** One .safetensors checkpoint holding model + CLIP + VAE (SD1.5/SDXL/Illustrious/NoobAI/Pony). */
    CHECKPOINT: 'checkpoint',
    /** Separate diffusion model, text encoder and VAE files (Anima, Flux, Qwen-Image, Z-Image ...). */
    SPLIT: 'split',
};

/** The generation fields a profile owns. URL and the user's own negative prompt stay global. */
export const PROFILE_GENERATION_KEYS = ['family', 'checkpoint', 'unet', 'unetDtype', 'clip', 'clipType', 'vae', 'sampler', 'scheduler', 'steps', 'cfg', 'width', 'height', 'modelNegative', 'loras'];

function slug(text) {
    return String(text || 'profile').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
}

/** Snapshot of the live settings as a profile. */
export function profileFromSettings(settings, { id, name, notes = '' } = {}) {
    const generation = {};
    for (const key of PROFILE_GENERATION_KEYS) generation[key] = settings.comfy?.[key];
    const preset = settings.promptPresets?.[settings.promptStyle];
    return {
        id: id || slug(name || settings.comfy?.checkpoint || settings.comfy?.unet),
        name: name || settings.comfy?.checkpoint || settings.comfy?.unet || 'Profile',
        promptStyle: settings.promptStyle,
        // The prefix/suffix this model wants for its Prompt Style (quality tags differ per model even
        // within one style). Copied into promptPresets[style] when the profile is applied.
        promptPreset: preset ? { prefix: preset.prefix || '', suffix: preset.suffix || '' } : null,
        generation,
        notes,
    };
}

/** Copies a profile into the live settings. Returns the settings for chaining. */
export function applyProfile(settings, profile) {
    if (!profile) return settings;
    if (profile.promptStyle) settings.promptStyle = profile.promptStyle;
    if (profile.promptPreset && settings.promptPresets?.[settings.promptStyle]) {
        settings.promptPresets[settings.promptStyle].prefix = profile.promptPreset.prefix || '';
        settings.promptPresets[settings.promptStyle].suffix = profile.promptPreset.suffix || '';
    }
    for (const key of PROFILE_GENERATION_KEYS) {
        if (profile.generation && profile.generation[key] !== undefined) settings.comfy[key] = profile.generation[key];
    }
    settings.activeProfileId = profile.id;
    return settings;
}

/**
 * First run after this feature: the current settings become the first profile, so nothing about
 * the existing setup changes.
 */
export function ensureProfiles(settings) {
    if (!Array.isArray(settings.modelProfiles)) settings.modelProfiles = [];
    if (!settings.modelProfiles.length) {
        const first = profileFromSettings(settings, {
            id: 'illustrious-xl-v01',
            name: 'Illustrious-XL v0.1 (tags)',
            notes: 'Original setup. Workflow family: checkpoint (workflows/000, 001).',
        });
        settings.modelProfiles.push(first);
        settings.activeProfileId = first.id;
    }
    if (!settings.modelProfiles.some((p) => p.id === settings.activeProfileId)) {
        settings.activeProfileId = settings.modelProfiles[0].id;
    }
    // Profiles saved before presets were part of a profile: the active one takes the live preset.
    const active = settings.modelProfiles.find((p) => p.id === settings.activeProfileId);
    if (active && !active.promptPreset && settings.promptPresets?.[active.promptStyle]) {
        const preset = settings.promptPresets[active.promptStyle];
        active.promptPreset = { prefix: preset.prefix || '', suffix: preset.suffix || '' };
    }
    return settings;
}

export function getActiveProfile(settings) {
    return (settings.modelProfiles || []).find((p) => p.id === settings.activeProfileId) || null;
}

/** Adds or replaces (by id) a profile. */
export function upsertProfile(settings, profile) {
    const i = settings.modelProfiles.findIndex((p) => p.id === profile.id);
    if (i >= 0) settings.modelProfiles[i] = profile; else settings.modelProfiles.push(profile);
    return profile;
}
