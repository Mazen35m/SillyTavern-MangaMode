// Custom workflow: draw every frame with a workflow the user builds in ComfyUI itself.
//
// Build or change the workflow in ComfyUI (add a LoRA, an upscaler, any node), press Ctrl+S, and
// the next frame MangaMode draws uses it - no export, no restart. The small ComfyUI add-on
// "ComfyUI-MangaMode-Bridge" makes that possible: when a workflow is saved in ComfyUI it also
// keeps ComfyUI's own runnable ("API") version of it and copies it into SillyTavern's ComfyUI
// workflow folder as "MangaMode - <name>.json" (the editable version as "MangaMode - <name>.ui").
// MangaMode reads them through SillyTavern's own server, like SillyTavern's image generation does,
// so the browser never has to talk to ComfyUI directly (ComfyUI refuses that, rightly).
//
// What MangaMode fills in each frame:
// - %prompt% and %negative% typed into any text field (optional: without them, the text boxes that
//   feed the sampler's positive and negative inputs are filled);
// - the seed of every sampler (new each frame), and the width/height of the empty latent image;
// - for a character reference (an IP-Adapter, for example): %reference% and %reference_face% in the
//   base64 box of an "easy loadImageBase64" node get the face picture of the one person in the
//   frame (%reference_full%: their full-body sheet), and the strength/weight of every IP-Adapter node gets the reference
//   strength from the settings (number boxes cannot hold a %placeholder%) - or a plain grey
//   picture and strength 0 when the frame has no single known person, so the same workflow works
//   for every frame.
// Everything else stays exactly as saved.
import { hashString } from './util.js';

const PREFIX = 'MangaMode - ';

/** A 64x64 grey PNG: the reference of a frame without one (drawn at weight 0). */
export const BLANK_REFERENCE = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAYElEQVR4nO3PQQ0AIBDAMED5SUcEj4ZkVbDtmVk/OzrgVQNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgPaBaIsAgBhHc02AAAAAElFTkSuQmCC';

/** True when the saved graph takes a character reference (%reference%). Pure. */
export function wantsReference(api) {
    return JSON.stringify(api || {}).includes('%reference');
}

/** The reference values for one frame. Pure. */
export function referenceValues(refs, strength = 1) {
    const has = Array.isArray(refs) && refs.length > 0;
    // %reference% is the face picture (head and shoulders): it carries the face best and brings
    // the least background along. %reference_full% is the full-body sheet.
    return {
        reference: has ? (refs[1] || refs[0]) : BLANK_REFERENCE,
        reference_face: has ? (refs[1] || refs[0]) : BLANK_REFERENCE,
        reference_full: has ? refs[0] : BLANK_REFERENCE,
        reference_weight: has ? (Number.isFinite(Number(strength)) && strength !== null && strength !== '' ? Number(strength) : 1) : 0,
    };
}

function headers() {
    const context = globalThis.SillyTavern?.getContext?.();
    return context?.getRequestHeaders ? context.getRequestHeaders() : { 'Content-Type': 'application/json' };
}

async function tavernPost(path, body) {
    const r = await fetch(`/api/sd/comfy/${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`SillyTavern answered ${r.status}`);
    return r.json();
}

/** The workflow name shown to the user for a file in SillyTavern's workflow folder, or null. Pure. */
export function workflowNameOf(file) {
    const f = String(file || '');
    return f.startsWith(PREFIX) && f.toLowerCase().endsWith('.json') ? f.slice(PREFIX.length, -5) : null;
}

/** Names of the workflows saved in ComfyUI with a runnable version. */
export async function listCustomWorkflows() {
    const files = await tavernPost('workflows', {});
    return (Array.isArray(files) ? files : []).map(workflowNameOf).filter(Boolean);
}

async function readTavernFile(fileName) {
    const text = await tavernPost('workflow', { file_name: fileName });
    return typeof text === 'string' ? JSON.parse(text) : text;
}

/** One saved workflow: { api, ui }. */
export async function loadCustomWorkflow(_comfyUrl, name) {
    if (!(await listCustomWorkflows()).includes(name)) {
        throw new Error(`workflow "${name}" is not in SillyTavern yet - open it in ComfyUI and press Ctrl+S (the MangaMode bridge copies it)`);
    }
    const api = await readTavernFile(`${PREFIX}${name}.json`);
    let ui = null;
    try {
        const u = await readTavernFile(`${PREFIX}${name}.ui`);
        ui = Array.isArray(u?.nodes) ? u : null; // a missing file comes back as SillyTavern's default workflow
    } catch { /* the editable version is optional */ }
    return { api, ui };
}

/**
 * A fingerprint of the saved workflow FILE, for the cache key of a drawn reply: editing the workflow in
 * ComfyUI (a LoRA, a step count) changes what every frame looks like, but its name stays the same.
 * '' when no custom workflow is switched on or it cannot be read (then the draw itself reports why).
 */
export async function workflowSignature(settings) {
    const cw = settings?.customWorkflow;
    if (!cw?.enabled || !cw.name) return '';
    try {
        const wf = await loadCustomWorkflow(settings.comfy?.url, cw.name);
        return hashString(JSON.stringify(wf.api || {}));
    } catch {
        return '';
    }
}

/** A short status line for the settings panel. */
export async function customWorkflowStatus(settings) {
    const cw = settings.customWorkflow || {};
    if (!cw.enabled) return 'Frames are drawn with the built-in workflow (its model files and sampler are under Advanced settings).';
    if (!cw.name) return 'Choose a workflow saved in ComfyUI.';
    try {
        const wf = await loadCustomWorkflow(settings.comfy.url, cw.name);
        const text = JSON.stringify(wf.api);
        const how = text.includes('%prompt%') ? 'prompt goes into %prompt%' : 'prompt goes into the text box feeding the sampler';
        return `Using your workflow "${cw.name}" (${Object.keys(wf.api || {}).length} nodes, ${how}). Edit it in ComfyUI and press Ctrl+S - the next frame uses it.`;
    } catch (error) {
        return `Problem: ${error?.message || error}`;
    }
}

const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string';

/** Replaces %name% placeholders in every string input; whole-value placeholders keep their type. Pure. */
export function fillPlaceholders(graph, values) {
    const out = structuredClone(graph);
    let used = new Set();
    for (const node of Object.values(out)) {
        for (const [key, value] of Object.entries(node?.inputs || {})) {
            if (typeof value !== 'string' || !value.includes('%')) continue;
            const whole = value.match(/^%(\w+)%$/);
            if (whole && whole[1] in values) {
                node.inputs[key] = values[whole[1]];
                used.add(whole[1]);
                continue;
            }
            node.inputs[key] = value.replace(/%(\w+)%/g, (m, name) => {
                if (!(name in values)) return m;
                used.add(name);
                return String(values[name]);
            });
        }
    }
    return { graph: out, used };
}

/** The text node feeding a sampler input, followed back through conditioning nodes. Pure. */
function textSourceOf(graph, link, depth = 0) {
    if (!isLink(link) || depth > 6) return null;
    const node = graph[link[0]];
    if (!node) return null;
    if (typeof node.inputs?.text === 'string' || typeof node.inputs?.prompt === 'string') return { id: link[0], key: typeof node.inputs.text === 'string' ? 'text' : 'prompt' };
    for (const [key, value] of Object.entries(node.inputs || {})) {
        if (isLink(value) && /conditioning|positive|negative|cond/i.test(key)) {
            const found = textSourceOf(graph, value, depth + 1);
            if (found) return found;
        }
    }
    return null;
}

const SAMPLER = (node) => node?.inputs && ('positive' in node.inputs) && ('negative' in node.inputs);

/**
 * The runnable graph for one frame. Pure.
 * @param {object} api The saved API graph.
 * @param {{prompt: string, negative: string, seed: number, width: number, height: number, refs?: string[], referenceStrength?: number}} v
 */
export function prepareCustomGraph(api, v) {
    const { graph, used } = fillPlaceholders(api, { prompt: v.prompt, negative: v.negative, seed: v.seed, width: v.width, height: v.height, ...referenceValues(v.refs, v.referenceStrength) });
    const samplers = Object.values(graph).filter(SAMPLER);
    if (!used.has('prompt')) {
        const targets = samplers.map((s) => textSourceOf(graph, s.inputs.positive)).filter(Boolean);
        if (!targets.length) throw new Error('the workflow has no %prompt% and no text box feeding a sampler\'s positive input');
        for (const t of targets) graph[t.id].inputs[t.key] = v.prompt;
    }
    if (!used.has('negative')) {
        for (const t of samplers.map((s) => textSourceOf(graph, s.inputs.negative)).filter(Boolean)) {
            const current = String(graph[t.id].inputs[t.key] || '');
            graph[t.id].inputs[t.key] = current.trim() ? current : v.negative;
        }
    }
    // Seed and size of THIS frame go in first, whatever happens to the adapter below. (1.07 returned
    // before this point when the adapter was taken out, so every frame without a reference was drawn
    // with the workflow's own saved seed and size: a redraw gave the same picture again.)
    let n = 0;
    for (const node of Object.values(graph)) {
        for (const key of ['seed', 'noise_seed']) {
            if (typeof node?.inputs?.[key] === 'number' && !used.has('seed')) node.inputs[key] = (v.seed + n++) % 2 ** 50;
        }
        const i = node?.inputs || {};
        if (!used.has('width') && typeof i.width === 'number' && typeof i.height === 'number' && 'batch_size' in i) {
            i.width = v.width;
            i.height = v.height;
        }
    }
    // No reference for this frame: the adapter is taken out of the graph, so the model runs exactly
    // as the same workflow without it. At strength 0 it was not neutral: the Anima IP-Adapter still
    // installs its LoRA on every cross-attention layer and feeds learned "empty" tokens, and frames
    // drawn that way had a large white area 14-21% of the time against 1% for the same workflow
    // without the adapter (186 saved replies, 2026-09-26 to 09-30).
    if (wantsReference(api) && !(Array.isArray(v.refs) && v.refs.length) && !v.keepUnusedAdapter) return withoutAdapter(graph);
    if (wantsReference(api)) {
        const weight = referenceValues(v.refs, v.referenceStrength).reference_weight;
        for (const node of Object.values(graph)) {
            if (!/ip.?adapter/i.test(node?.class_type || '')) continue;
            for (const key of ['strength', 'weight']) if (typeof node.inputs?.[key] === 'number') node.inputs[key] = weight;
        }
    }
    return graph;
}

const ADAPTER = /ip.?adapter/i;
const ADAPTER_PART = /ip.?adapter|loadImageBase64|clip.?vision|insightface/i;

/**
 * The graph with every IP-Adapter node taken out: whatever took the adapter's model output takes
 * the model the adapter was given, and the adapter's own loaders and picture inputs go too. Pure.
 */
export function withoutAdapter(graph) {
    const g = structuredClone(graph);
    const applies = Object.entries(g).filter(([, n]) => ADAPTER.test(n?.class_type || '') && isLink(n?.inputs?.model));
    for (const [id, node] of applies) {
        for (const other of Object.values(g)) {
            for (const [key, value] of Object.entries(other?.inputs || {})) {
                if (isLink(value) && value[0] === id) other.inputs[key] = node.inputs.model;
            }
        }
        delete g[id];
    }
    // Loaders and reference pictures nothing reads any more.
    for (let changed = true; changed;) {
        changed = false;
        const used = new Set(Object.values(g).flatMap((n) => Object.values(n?.inputs || {}).filter(isLink).map((l) => l[0])));
        for (const [id, node] of Object.entries(g)) {
            if (!used.has(id) && ADAPTER_PART.test(node?.class_type || '')) { delete g[id]; changed = true; }
        }
    }
    return g;
}

/**
 * The img2img version of a custom graph for the detail pass: the empty latent of the sampler is
 * replaced by the given picture (base64) scaled and encoded with the graph's own VAE, at `denoise`.
 * Null when the graph has no plain sampler/VAE pair to hook into (the built-in pass is used). Pure.
 */
export function refineFromCustom(graph, { base64, width, height, denoise }) {
    const g = structuredClone(graph);
    const sampler = Object.entries(g).find(([, n]) => SAMPLER(n) && 'denoise' in (n.inputs || {}) && isLink(n.inputs.latent_image));
    const decode = Object.values(g).find((n) => n?.class_type === 'VAEDecode' && isLink(n.inputs?.vae));
    if (!sampler || !decode) return null;
    g.mm_load = { class_type: 'easy loadImageBase64', inputs: { base64_data: base64, image_output: 'Hide', save_prefix: 'manga_refine' } };
    g.mm_scale = { class_type: 'ImageScale', inputs: { image: ['mm_load', 0], upscale_method: 'lanczos', width, height, crop: 'disabled' } };
    g.mm_encode = { class_type: 'VAEEncode', inputs: { pixels: ['mm_scale', 0], vae: decode.inputs.vae } };
    sampler[1].inputs.latent_image = ['mm_encode', 0];
    sampler[1].inputs.denoise = denoise;
    return g;
}

/** The saved UI graph with the placeholders filled, so the job in ComfyUI's queue shows the real prompt. */
export function filledUi(ui, v) {
    if (!ui) return null;
    const text = JSON.stringify(ui)
        .replaceAll('%prompt%', JSON.stringify(v.prompt).slice(1, -1))
        .replaceAll('%negative%', JSON.stringify(v.negative).slice(1, -1));
    try { return JSON.parse(text); } catch { return null; }
}
