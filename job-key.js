// The cache key of one drawn reply: everything that changes what the reply looks like, nothing else.
// Pure (no SillyTavern), so tests can prove that every picture-changing setting is in it.

// Settings added to the key after 1.07 shipped. They enter it only when they differ from the default,
// so a page saved by 1.07 with default values keeps the key it was saved under (and stays "fresh").
const LATER_DEFAULTS = {
    faceTouchUp: false,
    parserReasoning: 'minimal',
    fullBleedCooldown: 10,
    detailPass: true,
    redrawMinor: undefined,
    characterReference: false,
    webtoonMode: false,
    // Adapters, styles and moment cards (1.1): in the key only when they differ from what 1.0.x did.
    modelAdapter: '',
    artistStyle: '',
};
// Only read when a character reference is used at all (otherwise they cannot change a picture).
const REFERENCE_DEFAULTS = {
    referenceLora: 'anima-incontext-character.safetensors',
    referenceLoraStrength: 0.5,
    referenceStrength: 1,
    ipAdapterStrength: 0.6,
};

/**
 * @param {string} messageText
 * @param {object} rawSettings Manga Mode settings.
 * @param {{pipeline?: string, workflowSig?: string, legacy?: boolean}} [extra] pipeline: "version:version" of the code;
 *   workflowSig: a fingerprint of the custom workflow FILE (its name alone does not say it was edited);
 *   legacy: the key exactly as 1.07 made it (no workflow fingerprint, none of the later settings), so
 *   pages saved by 1.07 are still found fresh.
 * @returns {Array} the parts to hash
 */
export function jobKeyParts(messageText, rawSettings, { pipeline = '', workflowSig = '', legacy = false } = {}) {
    const settings = rawSettings;
    const parts = [
        `pipeline:${pipeline}`,
        messageText,
        settings.connectionProfileId,
        settings.promptStyle,
        settings.promptPresets,
        settings.comfy,
        settings.sceneContext ? 1 : 0,
        `${settings.maxPanels}:${settings.splitDialogueThreshold}:${settings.maxImages}:${settings.innerThoughts ? 1 : 0}`,
        '', // retired 'full mode' slot, kept so the key layout (and 1.07 legacy keys) stays the same
        settings.playerPov ? 'pov' : '',
        settings.qualityCheck ? `qc:${settings.visionModel}:${settings.maxRedraws}` : '',
        settings.customWorkflow?.enabled ? `wf:${settings.customWorkflow.name}${workflowSig && !legacy ? `:${workflowSig}` : ''}` : '',
        '', // retired 'speed mode' slot
    ];
    if (legacy) return parts;
    const changed = {};
    for (const [key, fallback] of Object.entries(LATER_DEFAULTS)) {
        if (settings[key] !== undefined && settings[key] !== fallback) changed[key] = settings[key];
    }
    if (settings.characterReference || settings.customWorkflow?.enabled) {
        // A custom workflow with an IP-Adapter reads the reference settings too.
        for (const [key, fallback] of Object.entries(REFERENCE_DEFAULTS)) {
            if (settings.characterReference && settings[key] !== undefined && settings[key] !== fallback) changed[key] = settings[key];
        }
    }
    // 'webtoon-color' and 'custom' read the same text as 1.0.x (the presets are in the key above); any other look changes pictures.
    if (settings.styleProfile !== undefined && !['webtoon-color', 'custom'].includes(settings.styleProfile)) changed.styleProfile = settings.styleProfile;
    const names = Object.keys(changed).sort();
    if (names.length) parts.push(`more:${JSON.stringify(names.map((k) => [k, changed[k]]))}`);
    return parts;
}
