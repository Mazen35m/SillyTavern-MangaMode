// Model adapters and style profiles.
//
// WHY THIS FILE EXISTS. The core of Manga Mode (reading the story, the moment cards, choosing shots, laying out
// pages and balloons) knows nothing about any one image model. Everything that is true of ONE model - how it
// likes to be spoken to, which failure modes needed a patch, what its quality tokens are, what its sampler
// settings are, whether it can use a negative prompt, which reference nodes exist for it - lives in an
// adapter here, and only there. Choosing a better model means choosing (or adding) an adapter; the core does
// not change.
//
// Three separate things, deliberately not mixed:
//   1. STYLE PROFILE  - the look the user wants (coloured webtoon, black-and-white manga, ...). Model-free
//                       words; the adapter decides how they are phrased for its model.
//   2. ADAPTER        - one image model's dialect, capabilities and quality tokens (never patches, on the new path).
//   3. SAFETY RULES   - never here: the guards against drawing minors, and the content limits, are the same
//                       for every model and live in the core (image-generator.js withSafetyNegative, text rules).
//
// THE NEW PATH (planning "moment") HAS NO PATCHES, FOR ANY ADAPTER. A patch is a sentence or a rule added to
// the prompt or the picture pipeline because a specific model drew something wrong without it. 1.1 removed
// them all from the new path (see docs/RULES.md): `dialectOf` returns NO_PATCHES whenever the planning is
// "moment", whatever adapter is chosen, and there is no setting that turns one back on.
//
// The Classic path (planning "classic", the default) is the 1.0.x behaviour kept for comparison and rollback.
// It still contains the old Anima patches, as LEGACY_ANIMA_PATCHES below; they are not part of any adapter and
// are used by nothing else. A patch comes back to the new path only as a written, measured case.

/** The dialect the prompt builder reads. Every flag is a patch or a wording choice, never a story rule. */
export const NO_PATCHES = Object.freeze({
    // Booru framing tags ("upper body, cowboy shot") put in front of a sentence prompt.
    framingTags: false,
    // "Posture said on its own, right after who is in the picture".
    postureSentence: false,
    // "On the left, ... On the right, ..." in front of each person of a multi-person frame.
    sideAnchors: false,
    // "... are in one open space", "face each other with a few steps between them", and the removal of
    // dividers / glass from the scenery between two people who talk.
    openSpace: false,
    // "Composition: X is placed in the left third of the frame, with open space on the right."
    compositionThird: false,
    // A dark frame also says "low-key and dim, with deep shadows ... not evenly lit".
    darkReinforce: false,
    // "The background is the setting itself, fully drawn and painted edge to edge."
    edgeBackground: false,
    // "It is one single continuous picture."
    singlePicture: false,
    // "Signs, pages and screens in the picture show only small pictures and unreadable marks."
    noTextSentence: false,
    // The long guard sentences of hand close-ups ("seen from the side across the table, forearms on its edge ...").
    insertGuards: false,
    // Outfit rewrites: a printed shirt becomes "a small picture print"; "a scrunchie on wrist" becomes "on one wrist".
    outfitFixes: false,
    // "..., his eyes on that person's face, even while the hands are busy" after a plain "looks at".
    gazeHoldingClause: false,
    // Onlooker handling: "X and Y are turned toward Z, watching", the far-away watcher "seen from behind at a
    // three-quarter angle", and "looks away from the viewer, into the picture".
    onlookerFixes: false,
    // A dark frame drops "vibrant full color" from the style's closing words.
    darkDropsVibrant: false,
    // The director alternates the side of the third single-person frame in a row (scene-parser withComposition).
    sideAlternation: false,
    // Close-ups drawn as an upper-body picture and cut to the head; tall frames drawn wider and cut to shape
    // (frame-plan drawPlanFor). Off: every frame is drawn once, at the layout's own shape and with its own camera words.
    cropFrames: false,
});

/**
 * LEGACY, CLASSIC PATH ONLY. The patches that the 1.0.x code applied for Anima (Turbo and base). They stay so the
 * Classic path keeps its exact old behaviour for comparison and rollback; the new path never reads them.
 * Evidence per flag (all found on Anima Turbo, never shown to be needed by another model):
 * - framingTags: Anima keeps to booru framing tags best (its README: tags then sentences).
 * - postureSentence: sitting drawn 4 of 4 with the sentence, standing 4 of 4 without (2026-10-01).
 * - sideAnchors: the vendor's apron leaked onto the other woman 3 of 4 times without anchors, 0 of 4 with (2026-09-30).
 * - openSpace: a wall between two talking people on 8 of 8 seeds at CFG 1 without it.
 * - compositionThird: same-seed test, the figure and the camera moved (1.15).
 * - darkReinforce: night scenes came out evenly bright (1.15 review).
 * - edgeBackground / singlePicture: blank white backgrounds (27-30% white pixels) and two stacked panels of one moment.
 * - noTextSentence: gibberish lettering on signs and screens.
 * - insertGuards: a hand-over drawn with the VIEWER's hands (6 of 6, 2026-09-30).
 * - outfitFixes: printed words came out as gibberish lettering on shirts; "a scrunchie on wrist" drawn on both wrists.
 * - gazeHoldingClause: a person who holds a cup was drawn looking down at it.
 * - onlookerFixes: onlookers drawn lined up facing the viewer like a group photo.
 * - darkDropsVibrant: night scenes came out evenly bright (Gemini review, 1.15).
 * - sideAlternation: Anima draws a lone figure dead centre unless told otherwise.
 * - cropFrames: asked for a close-up directly, Anima drew whole bodies and second copies of the person.
 */
export const LEGACY_ANIMA_PATCHES = Object.freeze({
    framingTags: true,
    postureSentence: true,
    sideAnchors: true,
    openSpace: true,
    compositionThird: true,
    darkReinforce: true,
    edgeBackground: true,
    singlePicture: true,
    noTextSentence: true,
    insertGuards: true,
    outfitFixes: true,
    gazeHoldingClause: true,
    onlookerFixes: true,
    darkDropsVibrant: true,
    sideAlternation: true,
    cropFrames: true,
});

/**
 * LEGACY, CLASSIC PATH ONLY. 1.0.x applied these six rewrites for every model, not only Anima, so the Classic path
 * keeps applying them to every adapter (its behaviour must not change). The new path applies none of them.
 */
export const LEGACY_SHARED_PATCHES = Object.freeze({
    ...NO_PATCHES,
    outfitFixes: true,
    gazeHoldingClause: true,
    onlookerFixes: true,
    darkDropsVibrant: true,
    sideAlternation: true,
    cropFrames: true,
});

export const ADAPTERS = Object.freeze({
    anima: Object.freeze({
        id: 'anima',
        name: 'Anima (Turbo or base) - tags then sentences',
        promptStyle: 'natural',
        // Its own quality tokens: not part of any style.
        quality: Object.freeze({ natural: 'masterpiece, best quality, score_7' }),
        caps: Object.freeze({
            // Turbo runs at CFG 1: a negative prompt does almost nothing there. Base/Aesthetic (CFG 4-5) uses it.
            negativeAtCfg1: false,
            textEncoder: 'qwen3-0.6b',
            // Small text encoder: short, concrete prompts keep their details; long prose loses them.
            longPromptsOk: false,
            artistTags: 'at-sign',
            characterReference: 'anima-incontext',
        }),
    }),
    // A neutral sentence adapter for models that read plain English well (Flux, Qwen-Image, Z-Image, SD3, ...):
    // no booru tokens, no patches.
    sentences: Object.freeze({
        id: 'sentences',
        name: 'Plain sentences (Flux / Qwen-Image / Z-Image / SD3 style) - no patches',
        promptStyle: 'natural',
        quality: Object.freeze({ natural: '' }),
        caps: Object.freeze({ negativeAtCfg1: false, textEncoder: 'large', longPromptsOk: true, artistTags: 'style-phrase', characterReference: null }),
    }),
    illustrious: Object.freeze({
        id: 'illustrious',
        name: 'Illustrious / NoobAI / SDXL anime - tags',
        promptStyle: 'tags',
        quality: Object.freeze({ tags: 'masterpiece, best quality' }),
        caps: Object.freeze({ negativeAtCfg1: true, textEncoder: 'clip', longPromptsOk: false, artistTags: 'plain', characterReference: null }),
    }),
    pony: Object.freeze({
        id: 'pony',
        name: 'Pony-family - score tags',
        promptStyle: 'tags_pony',
        quality: Object.freeze({ tags_pony: 'score_9, score_8_up, score_7_up, score_6_up' }),
        caps: Object.freeze({ negativeAtCfg1: true, textEncoder: 'clip', longPromptsOk: false, artistTags: 'plain', characterReference: null }),
    }),
});

export const DEFAULT_ADAPTER_ID = 'anima';

/** The adapter a settings object selects. Settings saved before adapters existed keep their behaviour: natural -> anima, tags -> illustrious. */
export function resolveAdapter(settings) {
    const wanted = String(settings?.modelAdapter || '').trim();
    if (ADAPTERS[wanted]) return ADAPTERS[wanted];
    const style = settings?.promptStyle;
    if (style === 'tags') return ADAPTERS.illustrious;
    if (style === 'tags_pony') return ADAPTERS.pony;
    return ADAPTERS[DEFAULT_ADAPTER_ID];
}

/**
 * The patches a context may use. The new path ("moment" planning) gets none, for every adapter. The Classic path keeps
 * the 1.0.x behaviour: all legacy patches for Anima (and for settings with no adapter), the six shared ones for the others.
 */
export function dialectOf(ctx) {
    if (ctx?.pipeline === 'moment') return NO_PATCHES;
    if (!ctx?.adapter) return LEGACY_ANIMA_PATCHES;
    return ctx.adapter.id === 'anima' ? LEGACY_ANIMA_PATCHES : LEGACY_SHARED_PATCHES;
}

/** Same rule for code that has no prompt context (scene normalising, frame plans): the patches of a planning mode + adapter. */
export function patchesFor({ pipeline = 'classic', adapter = null } = {}) {
    return dialectOf({ pipeline, adapter });
}

// ---------------------------------------------------------------- style profiles

/**
 * Looks, written once in model-free words. `sentence` is the picture's first words, `finish` its closing
 * words (sentence prompts); `tags` the same as booru tags. Quality tokens are NOT here (they belong to the adapter).
 */
export const STYLE_PROFILES = Object.freeze({
    'webtoon-color': Object.freeze({
        id: 'webtoon-color',
        name: 'Coloured webtoon / manhwa',
        sentence: 'A colored webtoon manhwa illustration.',
        finish: 'Clean digital lineart, cel shading, vibrant full color.',
        tags: 'colored manhwa style, webtoon illustration, full color, clean digital lineart, cel shading, vibrant colors',
        tagsPony: 'colored manhwa style, webtoon illustration, full color, clean digital lineart, cel shading, vibrant colors',
    }),
    'manga-bw': Object.freeze({
        id: 'manga-bw',
        name: 'Black-and-white manga',
        sentence: 'A black and white manga illustration.',
        finish: 'Crisp inked lineart, screentone shading, high contrast, monochrome.',
        tags: 'monochrome, greyscale, manga style, inked lineart, screentone, high contrast',
        tagsPony: 'monochrome, greyscale, manga style, inked lineart, screentone, high contrast',
    }),
    'semi-realistic': Object.freeze({
        id: 'semi-realistic',
        name: 'Semi-realistic illustration',
        sentence: 'A semi-realistic digital illustration.',
        finish: 'Soft natural shading, detailed faces, realistic proportions, rich color.',
        tags: 'semi-realistic, detailed face, soft shading, realistic proportions, rich color',
        tagsPony: 'semi-realistic, detailed face, soft shading, realistic proportions, rich color',
    }),
    painterly: Object.freeze({
        id: 'painterly',
        name: 'Painterly illustration',
        sentence: 'A painterly illustration with visible brushwork.',
        finish: 'Soft painted shading, warm palette, expressive brushwork.',
        tags: 'painterly, visible brushwork, soft painted shading, warm palette',
        tagsPony: 'painterly, visible brushwork, soft painted shading, warm palette',
    }),
});

/** The legacy default presets (what 1.0.1 shipped), used to tell an untouched install from one the user edited. */
const LEGACY_DEFAULTS = Object.freeze({
    natural: { prefix: 'masterpiece, best quality, score_7, A colored webtoon manhwa illustration.', suffix: 'Clean digital lineart, cel shading, vibrant full color.' },
    tags: { prefix: '', suffix: 'masterpiece, best quality, colored manhwa style, webtoon illustration, full color, clean digital lineart, cel shading, vibrant colors' },
    tags_pony: { prefix: 'score_9, score_8_up, score_7_up, score_6_up', suffix: 'colored manhwa style, webtoon illustration, full color, clean digital lineart, cel shading, vibrant colors' },
});

/**
 * Anima's artist tags need an "@" ("@name"; "@[a|b]" blends); a plain-tag model takes "by name"; a sentence model
 * takes a style phrase. Returns '' for an empty field. Pure.
 */
export function artistPhrase(adapter, artistStyle) {
    const raw = String(artistStyle || '').trim();
    if (!raw) return '';
    const names = raw.split(/[,;]+/).map((n) => n.trim().replace(/^@/, '')).filter(Boolean);
    if (!names.length) return '';
    switch (adapter?.caps?.artistTags) {
        case 'at-sign': return names.map((n) => `@${n}`).join(', ');
        case 'plain': return names.map((n) => `by ${n}`).join(', ');
        case 'style-phrase': return `In the style of ${names.join(' and ')}.`;
        default: return '';
    }
}

/**
 * The prefix and suffix the prompt builder reads, for each prompt style. With styleProfile 'custom' (or none: an
 * install from before style profiles) the user's own presets are returned untouched. With a profile, the preset is
 * composed: the adapter's quality tokens + the style's words (+ the artist). For the default profile and the Anima
 * adapter the result is exactly the text 1.0.1 shipped (a test proves it). Pure.
 */
export function effectivePresets(settings) {
    const own = settings?.promptPresets || {};
    const profile = STYLE_PROFILES[settings?.styleProfile];
    const adapter = resolveAdapter(settings);
    const out = {};
    for (const style of ['natural', 'tags', 'tags_pony']) {
        const preset = own[style] || {};
        out[style] = { prefix: String(preset.prefix || ''), suffix: String(preset.suffix || '') };
    }
    const artist = artistPhrase(adapter, settings?.artistStyle);
    if (profile) {
        const quality = adapter.quality;
        // Sentence prompts.
        out.natural = {
            prefix: [quality.natural, artist && adapter.caps.artistTags === 'at-sign' ? artist : '', profile.sentence].filter(Boolean).join(', '),
            suffix: [profile.finish, artist && adapter.caps.artistTags === 'style-phrase' ? artist : ''].filter(Boolean).join(' '),
        };
        // Tag prompts (Illustrious-like and Pony-like): the quality tokens ride at the front of the end-tags, as 1.0.x did.
        const tagArtist = artist && adapter.caps.artistTags !== 'style-phrase' ? artist : '';
        out.tags = { prefix: tagArtist, suffix: [quality.tags || 'masterpiece, best quality', profile.tags].join(', ') };
        out.tags_pony = { prefix: [quality.tags_pony || 'score_9, score_8_up, score_7_up, score_6_up', tagArtist].filter(Boolean).join(', '), suffix: profile.tagsPony };
    } else if (artist) {
        // A custom preset keeps the user's words; the artist is added where the model expects it.
        if (adapter.caps.artistTags === 'style-phrase') out.natural.suffix = [out.natural.suffix, artist].filter(Boolean).join(' ');
        else out[adapter.promptStyle].prefix = [out[adapter.promptStyle].prefix.replace(/[.,\s]+$/, ''), artist].filter(Boolean).join(', ');
    }
    return out;
}

/**
 * Settings saved before style profiles: 'webtoon-color' when the presets are still the shipped ones, else 'custom' (the user
 * wrote their own words and keeps them). Idempotent. Pure on its input apart from setting the field.
 */
export function ensureStyleFields(settings) {
    if (settings.styleProfile === undefined) {
        const own = settings.promptPresets || {};
        const untouched = ['natural', 'tags', 'tags_pony'].every((s) => !own[s] || (own[s].prefix === LEGACY_DEFAULTS[s].prefix && own[s].suffix === LEGACY_DEFAULTS[s].suffix));
        settings.styleProfile = untouched ? 'webtoon-color' : 'custom';
    }
    if (settings.artistStyle === undefined) settings.artistStyle = '';
    return settings;
}
