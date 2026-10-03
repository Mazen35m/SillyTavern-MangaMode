import { uniqueStamp } from './util.js';
import { loadCustomWorkflow, prepareCustomGraph, refineFromCustom, filledUi, wantsReference } from './custom-workflow.js';

/**
 * Builds the ComfyUI API-format graph, using only node types shipped with a vanilla ComfyUI install.
 * With one prompt chunk this is exactly the original txt2img graph (workflows/000). With several
 * chunks (shared scene + one per person) each chunk is encoded on its own and joined with
 * ConditioningConcat (workflows/001) - the ComfyUI equivalent of A1111's BREAK, which keeps one
 * person's tags from bleeding onto another.
 * @param {object} params
 * @returns {object} ComfyUI workflow graph (node id -> {class_type, inputs}).
 */
/**
 * "style.safetensors:0.8, detail.safetensors" -> [{name, strength}]. Strength defaults to 1.
 */
export function parseLoraList(text) {
    return String(text || '').split(/[,\n]+/).map((part) => part.trim()).filter(Boolean).map((part) => {
        const m = part.match(/^(.*?)(?::\s*(-?\d+(?:\.\d+)?))?$/);
        const strength = m && m[2] !== undefined ? Number(m[2]) : 1;
        return { name: (m ? m[1] : part).trim(), strength: Number.isFinite(strength) ? strength : 1 };
    }).filter((l) => l.name);
}

export function buildComfyWorkflow({ checkpoint, positiveChunks, negativePrompt, sampler, scheduler, steps, cfg, width, height, seed, family = 'checkpoint', unet, unetDtype = 'default', clip, clipType = 'stable_diffusion', vae, loras = '' }) {
    // Loader nodes depend on the workflow family; everything after them is shared.
    const graph = {};
    let modelRef;
    let clipRef;
    let vaeRef;
    if (family === 'split') {
        // Separate files, as in ComfyUI's own "Text to Image (Anima)" blueprint:
        // UNETLoader + CLIPLoader + VAELoader (workflows/002).
        graph['4'] = { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: unetDtype || 'default' } };
        graph['10'] = { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: clipType || 'stable_diffusion' } };
        graph['11'] = { class_type: 'VAELoader', inputs: { vae_name: vae } };
        modelRef = ['4', 0];
        clipRef = ['10', 0];
        vaeRef = ['11', 0];
    } else {
        graph['4'] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } };
        modelRef = ['4', 0];
        clipRef = ['4', 1];
        vaeRef = ['4', 2];
        if (vae) {
            graph['11'] = { class_type: 'VAELoader', inputs: { vae_name: vae } };
            vaeRef = ['11', 0];
        }
    }
    // Style/detail LoRAs from the model profile, chained on the diffusion model (built-in
    // LoraLoaderModelOnly - Anima LoRAs patch the DiT only).
    parseLoraList(loras).forEach((lora, index) => {
        const id = String(40 + index);
        graph[id] = { class_type: 'LoraLoaderModelOnly', inputs: { model: modelRef, lora_name: lora.name, strength_model: lora.strength } };
        modelRef = [id, 0];
    });
    graph['5'] = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
    graph['6'] = { class_type: 'CLIPTextEncode', inputs: { text: positiveChunks[0], clip: clipRef } };
    graph['7'] = { class_type: 'CLIPTextEncode', inputs: { text: negativePrompt, clip: clipRef } };
    let positive = ['6', 0];
    positiveChunks.slice(1).forEach((chunk, index) => {
        const encodeId = String(20 + index * 2);
        const concatId = String(21 + index * 2);
        graph[encodeId] = { class_type: 'CLIPTextEncode', inputs: { text: chunk, clip: clipRef } };
        graph[concatId] = { class_type: 'ConditioningConcat', inputs: { conditioning_to: positive, conditioning_from: [encodeId, 0] } };
        positive = [concatId, 0];
    });
    graph['3'] = {
        class_type: 'KSampler',
        inputs: {
            seed,
            steps,
            cfg,
            sampler_name: sampler,
            scheduler,
            denoise: 1,
            model: modelRef,
            positive,
            negative: ['7', 0],
            latent_image: ['5', 0],
        },
    };
    graph['8'] = { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: vaeRef } };
    graph['9'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'manga', images: ['8', 0] } };
    return graph;
}

/**
 * Always appended to the negative prompt: the base checkpoint drifts toward chibi proportions
 * (small body, oversized head), and every character must keep adult proportions. (Clothing/NSFW terms
 * were removed from this list.)
 */
export const SAFETY_NEGATIVE = 'loli, shota, child, chibi, aged down';

/**
 * Each generation is ONE panel; the panel grid, gutters and lettering are MangaMode's job. With
 * webtoon/manhwa style tags the checkpoint sometimes draws a whole comic page inside one image
 * (seen live in a tall full-bleed panel), so page-layout tags are always negated too.
 */
export const LAYOUT_NEGATIVE = 'comic, multiple views, panel grid, split screen, 4koma, collage, border, frame';

export function withSafetyNegative(negative, modelNegative = '') {
    negative = [String(negative || '').trim(), String(modelNegative || '').trim()].filter(Boolean).join(', ');
    const have = new Set(String(negative || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean));
    const add = `${SAFETY_NEGATIVE}, ${LAYOUT_NEGATIVE}`.split(',').map((t) => t.trim()).filter((t) => !have.has(t.toLowerCase()));
    return [String(negative || '').trim(), add.join(', ')].filter(Boolean).join(', ');
}

function familyFields(comfy) {
    return { family: comfy.family || 'checkpoint', unet: comfy.unet, unetDtype: comfy.unetDtype, clip: comfy.clip, clipType: comfy.clipType, vae: comfy.vae, loras: comfy.loras || '' };
}

function assertModelFiles(comfy) {
    if ((comfy.family || 'checkpoint') === 'split') {
        const missing = ['unet', 'clip', 'vae'].filter((key) => !comfy[key]);
        if (missing.length) throw new Error(`Model profile is missing: ${missing.join(', ')} (split workflow needs a diffusion model, a text encoder and a VAE).`);
    } else if (!comfy.checkpoint) {
        throw new Error('No ComfyUI checkpoint selected in Manga Mode settings.');
    }
}

/** A ComfyUI request that produced no image within GENERATION_TIMEOUT_MS. */
export const GENERATION_TIMEOUT_MS = 120000;

export class GenerationTimeoutError extends Error {
    constructor(seconds) {
        super(`ComfyUI produced no image within ${seconds}s (timed out).`);
        this.name = 'GenerationTimeoutError';
    }
}

/**
 * Counters for how often ComfyUI hangs or fails, so a one-off hang can be told apart from a real
 * model/workflow problem. Session-only; inspect via the debug block or `window.MangaModeStats`.
 */
export const generationStats = { requests: 0, attempts: 0, timeouts: 0, retries: 0, retrySuccesses: 0, failures: 0 };
globalThis.MangaModeStats = generationStats;

/**
 * ComfyUI runs one prompt at a time anyway. Serialising MangaMode's own requests means a timeout
 * clock only ever measures our own job (not time spent queued behind another panel), and the
 * interrupt SillyTavern sends on abort can only ever hit the job that actually timed out.
 */
let comfyChain = Promise.resolve();
function serialized(task) {
    const run = comfyChain.then(task, task);
    comfyChain = run.catch(() => {});
    return run;
}

/**
 * One ComfyUI round trip through SillyTavern's proxy, aborted after `timeoutMs`. Aborting closes
 * the socket, which makes SillyTavern send ComfyUI an /interrupt for the unfinished prompt.
 */
async function postComfyOnce(context, url, workflow, timeoutMs, extraData = null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch('/api/sd/comfy/generate', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ url, prompt: JSON.stringify(extraData ? { prompt: workflow, extra_data: extraData } : { prompt: workflow }) }),
            signal: controller.signal,
        });
        if (!response.ok) {
            const text = await response.text();
            // SillyTavern's proxy answers "ComfyUI returned an error." when ComfyUI REJECTS the graph
            // (/prompt validation: a model file that isn't installed, an unknown node, a bad value)
            // and hides ComfyUI's details. That is deterministic - retrying cannot help - so say
            // what to check instead of retrying.
            const rejected = /ComfyUI returned an error\./i.test(text);
            const hint = rejected
                ? ' ComfyUI rejected the workflow - usually a model file named in the model profile is not installed (checkpoint, diffusion model, text encoder or VAE), or a node is missing. Check the ComfyUI console for the exact reason.'
                : '';
            const error = new Error(`ComfyUI generation failed: ${text}${hint}`);
            error.retryable = !rejected && !/did not succeed|validation|not found|Value not in list/i.test(text);
            throw error;
        }
        return await response.json();
    } catch (error) {
        if (controller.signal.aborted) {
            throw new GenerationTimeoutError(Math.round(timeoutMs / 1000));
        }
        if (error.retryable === undefined) error.retryable = true; // network-level failure
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Sends the workflow; on a timeout (or a transient failure) retries the identical request once.
 * A second failure is thrown as a normal generation failure so the panel shows an error state.
 */
export async function runComfyWithRetry(context, url, workflow, { timeoutMs = GENERATION_TIMEOUT_MS, extraData = null } = {}) {
    generationStats.requests++;
    return serialized(async () => {
        const started = performance.now();
        let timeouts = 0;
        for (let attempt = 1; attempt <= 2; attempt++) {
            generationStats.attempts++;
            try {
                const result = await postComfyOnce(context, url, workflow, timeoutMs, extraData);
                result.generation = { attempts: attempt, timeouts, seconds: Math.round((performance.now() - started) / 100) / 10 };
                if (attempt > 1) {
                    generationStats.retrySuccesses++;
                    console.info('[Manga Mode] ComfyUI retry succeeded.', { ...generationStats });
                }
                return result;
            } catch (error) {
                const timedOut = error instanceof GenerationTimeoutError;
                if (timedOut) {
                    generationStats.timeouts++;
                    timeouts++;
                }
                if (attempt === 1 && (timedOut || error.retryable)) {
                    generationStats.retries++;
                    console.warn(`[Manga Mode] ComfyUI ${timedOut ? 'timed out' : 'failed'} - retrying the same workflow once.`, error.message, { ...generationStats });
                    continue;
                }
                generationStats.failures++;
                console.error('[Manga Mode] ComfyUI generation failed' + (attempt > 1 ? ' after retry' : '') + '.', error.message, { ...generationStats });
                throw error;
            }
        }
    });
}

/**
 * Phase 4: generates one planned panel from ready-made prompt chunks at a given size.
 * @param {import('../../st-context.js').default} context
 * @param {{chunks: string[], width?: number, height?: number}} panel
 * @param {object} settings
 * @param {string} subFolder
 * @returns {Promise<{url: string, format: string, positivePrompt: string, negativePrompt: string, promptChunks: string[], generation: object, width: number, height: number}>}
 */
/** How long one ComfyUI job may take (settings; a heavy custom workflow can need minutes). */
function timeoutOf(settings) {
    return Math.max(30, Number(settings?.comfy?.timeoutSeconds) || 300) * 1000;
}

/** The custom workflow for a frame, when one is switched on: { graph, extraData } or null. */
async function customGraph(settings, { chunks, negativePrompt, width, height, seed, refs }) {
    const cw = settings.customWorkflow;
    if (!cw?.enabled || !cw.name) return null;
    const wf = await loadCustomWorkflow(settings.comfy.url, cw.name);
    const values = { prompt: chunks.join(', '), negative: negativePrompt, seed, width, height };
    const graph = prepareCustomGraph(wf.api, { ...values, refs, referenceStrength: settings.ipAdapterStrength ?? 0.6, keepUnusedAdapter: Boolean(cw.keepUnusedAdapter) });
    const ui = filledUi(wf.ui, values);
    return { graph, graphSource: wf.api, extraData: ui ? { extra_pnginfo: { workflow: ui } } : null };
}

export async function generatePanelImage(context, { chunks, width, height, refs = null, seed = null }, settings, subFolder) {
    const comfySettings = settings.comfy;
    if (!comfySettings.url) throw new Error('ComfyUI server URL is not set in Manga Mode settings.');
    const negativePrompt = withSafetyNegative(comfySettings.negativePrompt, comfySettings.modelNegative);
    const w = width || comfySettings.width;
    const h = height || comfySettings.height;
    const custom = await customGraph(settings, { chunks, negativePrompt, width: w, height: h, seed: Number.isFinite(seed) ? seed : Math.floor(Math.random() * 2 ** 48), refs });
    if (custom) {
        const { format, data, generation } = await runComfyWithRetry(context, comfySettings.url, custom.graph, { timeoutMs: timeoutOf(settings), extraData: custom.extraData });
        const path = await uploadImage(context, data, format, subFolder);
        return { url: path, format, positivePrompt: chunks.join('\nBREAK\n'), negativePrompt, promptChunks: chunks, generation, width: w, height: h, referenced: Boolean(refs?.length) && wantsReference(custom.graphSource), custom: settings.customWorkflow.name };
    }
    assertModelFiles(comfySettings);
    const workflow = buildComfyWorkflow({
        checkpoint: comfySettings.checkpoint,
        positiveChunks: chunks,
        negativePrompt,
        sampler: comfySettings.sampler,
        scheduler: comfySettings.scheduler,
        steps: comfySettings.steps,
        cfg: comfySettings.cfg,
        width: w,
        height: h,
        seed: Number.isFinite(seed) ? seed : Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
        ...familyFields(comfySettings),
    });
    if (refs?.length) addCharacterReference(workflow, { refs, width: w, height: h, ...referenceOptions(settings) });
    const { format, data, generation } = await runComfyWithRetry(context, comfySettings.url, workflow, { timeoutMs: timeoutOf(settings) });
    const path = await uploadImage(context, data, format, subFolder);
    return { url: path, format, positivePrompt: chunks.join('\nBREAK\n'), negativePrompt, promptChunks: chunks, generation, width: w, height: h, referenced: Boolean(refs?.length) };
}

/**
 * Character reference (Anima-InContext-Character): reference pictures of the people in the frame
 * are encoded and attached to the model as extra clean frames the generated picture attends to,
 * together with the in-context LoRA trained for it - the character's face, hair and clothes come
 * from the pictures instead of from text alone. Needs the comfyui-anima-incontext nodes.
 * @param {object} graph From buildComfyWorkflow (mutated and returned).
 * @param {{refs: string[], width: number, height: number, lora: string, loraStrength?: number, strength?: number}} options
 *   refs = base64 PNGs (full body + face per character).
 */
export function addCharacterReference(graph, { refs, width, height, lora, loraStrength = 1, strength = 1 }) {
    if (!Array.isArray(refs) || !refs.length || !graph?.['3']) return graph;
    const vaeRef = graph['11'] ? ['11', 0] : ['4', 2];
    let modelRef = graph['3'].inputs.model;
    if (lora) {
        graph['50'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: modelRef, lora_name: lora, strength_model: loraStrength } };
        modelRef = ['50', 0];
    }
    let latentRef = null;
    refs.forEach((b64, i) => {
        const load = String(60 + i);
        const enc = String(70 + i);
        graph[load] = { class_type: 'easy loadImageBase64', inputs: { base64_data: b64, image_output: 'Hide', save_prefix: 'manga_ref' } };
        graph[enc] = { class_type: 'AnimaRefEncode', inputs: { vae: vaeRef, image: [load, 0], target_width: width, target_height: height } };
        if (!latentRef) {
            latentRef = [enc, 0];
        } else {
            const batch = String(80 + i);
            graph[batch] = { class_type: 'AnimaRefLatentBatch', inputs: { ref_latent_1: latentRef, ref_latent_2: [enc, 0], fit_mode: 'pad' } };
            latentRef = [batch, 0];
        }
    });
    graph['90'] = {
        class_type: 'AnimaInContextApply',
        inputs: { model: modelRef, ref_latent: latentRef, strength, start_percent: 0, end_percent: 1, cond_only: true, fit_mode: 'pad', ref_timestep: 0 },
    };
    graph['3'].inputs.model = ['90', 0];
    return graph;
}

/**
 * The img2img graph for a detail pass: the given picture (base64) is scaled to width x height,
 * encoded and re-sampled at `denoise` with the same model and prompt style. Loading an image from
 * base64 needs the "easy loadImageBase64" node (ComfyUI-Easy-Use); without it the pass is skipped.
 */
export function buildRefineWorkflow({ base64, denoise, ...params }) {
    const graph = buildComfyWorkflow(params);
    const vaeRef = params.family === 'split' ? ['11', 0] : (params.vae ? ['11', 0] : ['4', 2]);
    graph['30'] = { class_type: 'easy loadImageBase64', inputs: { base64_data: base64, image_output: 'Hide', save_prefix: 'manga_refine' } };
    graph['31'] = { class_type: 'ImageScale', inputs: { image: ['30', 0], upscale_method: 'lanczos', width: params.width, height: params.height, crop: 'disabled' } };
    graph['32'] = { class_type: 'VAEEncode', inputs: { pixels: ['31', 0], vae: vaeRef } };
    delete graph['5'];
    graph['3'].inputs.latent_image = ['32', 0];
    graph['3'].inputs.denoise = denoise;
    return graph;
}

/**
 * Detail pass on a cropped close-up: the crop was scaled up from a few hundred pixels and looked
 * soft next to generated frames. Re-drawn at about 1 MP and ~0.38 denoise it gets clean lineart and
 * eye detail back while the face, pose and colours stay (fixed-seed test 2026-09-25: 0.3 keeps
 * everything but stays a little soft; 0.45 starts changing eye colour).
 * @returns {Promise<{url: string, generation: object}>}
 */
/** The in-context LoRA and strengths from the settings. */
export function referenceOptions(settings) {
    return {
        lora: settings.referenceLora || 'anima-incontext-character.safetensors',
        loraStrength: Number(settings.referenceLoraStrength ?? 1) || 1,
        strength: Number(settings.referenceStrength ?? 1) || 1,
    };
}

export async function refinePanelImage(context, { imageUrl, chunks, aspect, denoise = 0.38, refs = null, pixels: area = 1024 * 1024 }, settings, subFolder) {
    const comfySettings = settings.comfy;
    const blob = await (await fetch(imageUrl)).blob();
    const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('Could not read the image for the detail pass.'));
        reader.readAsDataURL(blob);
    });
    // The picture's own shape decides the size (it is stretched to exactly width x height).
    let shape = aspect;
    try {
        const bitmap = await createImageBitmap(blob);
        shape = bitmap.width / bitmap.height;
        bitmap.close();
    } catch { /* keep the caller's aspect */ }
    const pixels = area;
    const snap = (v) => Math.min(1664, Math.max(512, Math.round(v / 64) * 64));
    const width = snap(Math.sqrt(pixels * shape));
    const height = snap(pixels / width);
    const negativePrompt = withSafetyNegative(comfySettings.negativePrompt, comfySettings.modelNegative);
    const custom = await customGraph(settings, { chunks, negativePrompt, width, height, seed: Math.floor(Math.random() * 2 ** 48), refs });
    const customRefine = custom ? refineFromCustom(custom.graph, { base64, width, height, denoise }) : null;
    if (customRefine) {
        const { format, data, generation } = await runComfyWithRetry(context, comfySettings.url, customRefine, { timeoutMs: timeoutOf(settings) });
        return { url: await uploadImage(context, data, format, subFolder), generation };
    }
    const workflow = buildRefineWorkflow({
        base64,
        denoise,
        checkpoint: comfySettings.checkpoint,
        positiveChunks: chunks,
        negativePrompt: withSafetyNegative(comfySettings.negativePrompt, comfySettings.modelNegative),
        sampler: comfySettings.sampler,
        scheduler: comfySettings.scheduler,
        steps: comfySettings.steps,
        cfg: comfySettings.cfg,
        width,
        height,
        seed: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
        ...familyFields(comfySettings),
    });
    if (refs?.length) addCharacterReference(workflow, { refs, width, height, ...referenceOptions(settings) });
    const { format, data, generation } = await runComfyWithRetry(context, comfySettings.url, workflow, { timeoutMs: timeoutOf(settings) });
    const url = await uploadImage(context, data, format, subFolder);
    return { url, generation };
}

async function uploadImage(context, data, format, subFolder) {
    const uploadResponse = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ image: data, format, ch_name: subFolder, filename: `manga_${uniqueStamp()}` }),
    });
    if (!uploadResponse.ok) {
        const error = await uploadResponse.json().catch(() => ({}));
        throw new Error(error?.error || 'Failed to save the generated manga image.');
    }
    const { path } = await uploadResponse.json();
    return path;
}
