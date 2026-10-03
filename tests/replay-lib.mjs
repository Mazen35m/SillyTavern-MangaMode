// Replays recorded replies through the director + prompt builder + workflow builder, with no
// SillyTavern, no LLM and no ComfyUI. Used to prove that a refactor changes nothing: the same recorded
// storyboards must give the same prompts, negative prompt, settings and graph before and after.
//
// The recordings are a user's own chats and stay on their computer: this file only READS a folder
// named by MM_REPLAY_DIR (r01.json ... and fullchat.json, written by the capture snippet in
// docs/TESTING.md). Nothing from that folder is ever copied into the repository.
import fs from 'node:fs';
import path from 'node:path';
import { compileFrame } from '../prompt-builder.js';
import { planPanels, messagesSinceFullBleed, wantsEstablishing } from '../director.js';
import { drawPlanFor } from '../frame-plan.js';
import { buildComfyWorkflow, withSafetyNegative } from '../image-generator.js';
import { getSettings } from '../settings.js';
import { findKnownSet, mergeSet } from '../set-book.js';
import { resolveAdapter, effectivePresets, ADAPTERS } from '../model-adapters.js';

const FIXED_SEED = 123456789;

function clip(text, max) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? `...${clean.slice(clean.length - max)}` : clean;
}

/** The previous player message of a reply, as index.js getSceneContext reads it. */
function playerActionOf(chat, messageId) {
    for (let i = messageId - 1; i >= 0 && i >= messageId - 6; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        if (m.is_user) return clip(m.mes, 1200);
        return '';
    }
    return '';
}

/** Loads the recorded folder: { chat, rawSettings, replies: [{ file, tag, reply, manga, requests }] }. */
export function loadRecording(dir) {
    const full = JSON.parse(fs.readFileSync(path.join(dir, 'fullchat.json'), 'utf8'));
    const replies = fs.readdirSync(dir).filter((f) => /^r\d+\.json$/.test(f)).sort().map((file) => {
        const j = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        return { file, tag: j.tag, userText: j.userText, replyIndex: j.replyIndex, manga: j.manga, requests: j.comfyRequests || [] };
    });
    return { chat: full.chat, rawSettings: full.settings, replies };
}

/**
 * Everything one reply sends to ComfyUI, rebuilt from its recorded storyboard and the settings it
 * was drawn with. `compile` is the frame compiler under test (default: the current one).
 * @returns {{key: string, chunks: string[], width: number, height: number, graph: object, negative: string}[]}
 */
export function replayReply(rec, reply, { compile = compileFrame, settingsOverride = null, seed = FIXED_SEED, pipeline = null, adapter = null } = {}) {
    const settings = getSettings({ mangaMode: structuredClone(settingsOverride || rec.rawSettings) });
    const { chat } = rec;
    const message = chat[reply.replyIndex];
    const text = String(message.mes || '');
    const m = reply.manga;
    const scene = m.scene;
    const cast = m.cast;
    // The player's name is read from the recording itself (the first message the user wrote), never written into this file.
    const personaName = (chat.find((x) => x?.is_user)?.name) || 'player';
    const knownSet = findKnownSet(chat, reply.replyIndex);
    const setBook = mergeSet(knownSet, scene.places);
    const ctx = {
        style: settings.promptStyle,
        presets: effectivePresets(settings),
        adapter: adapter ? ADAPTERS[adapter] : resolveAdapter(settings),
        pipeline: pipeline || settings.pipeline || 'classic',
        cast,
        setBook,
        world: m.world ? { summary: m.world.summary, era_and_technology: m.world.era_and_technology } : null,
        setting: scene.setting,
        personaName,
        povMode: Boolean(settings.playerPov),
    };
    const plan = planPanels(scene, {
        maxPanels: settings.maxPanels,
        fullBleedCooldown: settings.fullBleedCooldown,
        sinceFullBleed: messagesSinceFullBleed(chat, reply.replyIndex, 50, new Set()),
        splitDialogueThreshold: settings.splitDialogueThreshold,
        defaultSize: { width: settings.comfy.width, height: settings.comfy.height },
        maxImages: settings.maxImages,
        playerName: personaName,
        seed: m.paramsHash,
        establishingHint: wantsEstablishing(text, playerActionOf(chat, reply.replyIndex)),
        webtoon: Boolean(settings.webtoonMode),
    });
    const negative = withSafetyNegative(settings.comfy.negativePrompt, settings.comfy.modelNegative);
    const jobs = [];
    const add = (key, args) => {
        const d = drawPlanFor(args, { personaName, cropFrames: ctx.pipeline !== 'moment' });
        const chunks = compile(d.spec, d.camera, ctx);
        const c = settings.comfy;
        const graph = buildComfyWorkflow({
            checkpoint: c.checkpoint, positiveChunks: chunks, negativePrompt: negative, sampler: c.sampler, scheduler: c.scheduler,
            steps: c.steps, cfg: c.cfg, width: d.width, height: d.height, seed,
            family: c.family || 'checkpoint', unet: c.unet, unetDtype: c.unetDtype, clip: c.clip, clipType: c.clipType, vae: c.vae, loras: c.loras || '',
        });
        jobs.push({ key, mode: d.mode, chunks, width: d.width, height: d.height, graph, negative });
    };
    for (const step of plan) {
        if (step.strategy === 'grid') {
            for (const fr of step.frames) {
                if (fr.strategy === 'reframe') continue;
                add(`${step.index}.${fr.frame}`, { spec: fr.spec, camera: fr.camera, size: fr.size, aspect: fr.rect.aspect, focusName: fr.focusName });
            }
        } else if (step.strategy === 'generate') {
            add(`${step.index}`, { spec: step.spec, camera: step.camera, size: step.size, aspect: null, focusName: step.focusName });
        }
    }
    return jobs;
}

/** A recorded ComfyUI request: its positive text, negative text and graph with the seed neutralised. */
export function recordedJob(request) {
    const g = JSON.parse(JSON.stringify(request.graph.prompt || request.graph));
    const ks = Object.values(g).find((n) => n.class_type === 'KSampler');
    const seed = ks?.inputs?.seed;
    if (ks) ks.inputs.seed = FIXED_SEED;
    return { seed, graph: g };
}

/**
 * What a graph asks ComfyUI for, independent of node numbering: the text of the positive and the
 * negative prompt (following conditioning concatenations), the sampler settings, the canvas, and
 * the model files. The user's own saved workflow and the built-in one number their nodes differently
 * but must agree on all of this.
 */
export function essentials(graph) {
    const g = graph.prompt || graph;
    const nodes = Object.values(g);
    const ks = nodes.find((n) => n.class_type === 'KSampler');
    const textOf = (ref) => {
        const n = g[ref[0]];
        if (!n) return null;
        if (n.class_type === 'CLIPTextEncode') return [n.inputs.text];
        if (n.class_type === 'ConditioningConcat') return [...textOf(n.inputs.conditioning_to), ...textOf(n.inputs.conditioning_from)];
        return null;
    };
    const latent = g[ks.inputs.latent_image[0]];
    const files = nodes.flatMap((n) => Object.entries(n.inputs || {}).filter(([k]) => /^(unet_name|ckpt_name|clip_name|vae_name|lora_name)$/.test(k)).map(([k, v]) => `${k}=${v}`)).sort();
    const loras = nodes.filter((n) => /Lora/i.test(n.class_type)).map((n) => `${n.inputs.lora_name}@${n.inputs.strength_model}`);
    const { seed, model, positive, negative, latent_image, ...samplerSettings } = ks.inputs;
    return { positive: textOf(positive), negative: textOf(negative), sampler: samplerSettings, width: latent?.inputs?.width, height: latent?.inputs?.height, files, loras };
}

export { FIXED_SEED };
