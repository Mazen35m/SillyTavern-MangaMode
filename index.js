import { EXTENSION_NAME, getSettings } from './settings.js';
import { parseScene, sceneProblem, normalizeScene } from './scene-parser.js';
import { generatePanelImage, refinePanelImage, withSafetyNegative } from './image-generator.js';
import { compileFrame, frameExpectation } from './prompt-builder.js';
import { drawPlanFor, redrawVariant, fallbackFromInsert } from './frame-plan.js';
import { planPanels, messagesSinceFullBleed, wantsEstablishing } from './director.js';
import { chooseLayout } from './page-layout.js';
import { addUsage } from './llm-request.js';
import { faceRegion, cropRegion, pasteRegion, createCropPanel, cropToHead, cropToAspect } from './panel-crop.js';
import { findKnownSet, mergeSet } from './set-book.js';
import { findKnownCast, mergeCast, uniqueLabels, findPerson } from './cast-book.js';
import { ensureWorldBook, WORLD_VERSION } from './world-book.js';
import { checkFrame, confirmVerdict, headOf, headsInCrop, headsOf, findByLabel } from './vision-check.js';
import { referencesFor, resetReferenceFailures } from './character-refs.js';
import { getActiveProfile, applyProfile, profileFromSettings, upsertProfile, WORKFLOW_FAMILIES } from './model-profiles.js';
import { injectMangaButton, renderMangaPanel, BUTTON_CLASS } from './renderer.js';
import { hashString, describeError, isTransientError } from './util.js';
import { jobKeyParts } from './job-key.js';
import { keepLastGood, withLedger, chatSpent } from './result-state.js';
import { customWorkflowStatus, listCustomWorkflows, loadCustomWorkflow, wantsReference, workflowSignature } from './custom-workflow.js';

const IMAGE_SUBFOLDER = 'manga-mode';

/** Bump when the drawing pipeline changes: old cached pages are then redrawn only on request. */
const PIPELINE_VERSION = 8;

/** Messages whose job planned a full-bleed panel but has not committed yet (concurrent regenerations). */
const pendingFullBleed = new WeakSet();

/** @type {Map<number, boolean>} Per-message "reveal text" overrides. Session-only, not persisted. */
const revealOverrides = new Map();

/**
 * Jobs currently generating, keyed by chat + message + swipe + params hash, so the same content is
 * never generated twice concurrently while a different swipe/edit of the same message is never
 * blocked by an older job.
 * @type {Set<string>}
 */
const inFlight = new Set();

function getChatId(context) {
    return String(context.getCurrentChatId?.() ?? context.chatId ?? '');
}

function jobKey(chatId, messageId, swipeId, hash) {
    return `${chatId}|${messageId}|${swipeId}|${hash}`;
}

function isJobRunning(context, messageId, message) {
    const manga = message?.extra?.manga;
    if (!manga?.paramsHash) return false;
    return inFlight.has(jobKey(getChatId(context), messageId, message.swipe_id ?? 0, manga.paramsHash));
}

function getMessageElement(messageId) {
    return $('#chat').find(`.mes[mesid="${messageId}"]`);
}

/**
 * The player's last message and the tail of the previous reply, so the director can draw what the
 * player is doing and keep who/where continuity. Context only - the page still depicts this reply.
 */
function getSceneContext(context, messageId, settings) {
    if (!settings.sceneContext) return null;
    const clip = (text, max) => {
        const clean = String(text || '').replace(/\s+/g, ' ').trim();
        return clean.length > max ? `...${clean.slice(clean.length - max)}` : clean;
    };
    let playerAction = '';
    let previousReply = '';
    for (let i = messageId - 1; i >= 0 && i >= messageId - 6; i--) {
        const m = context.chat[i];
        if (!m || m.is_system) continue;
        if (m.is_user && !playerAction && !previousReply) {
            playerAction = clip(m.mes, 1200);
        } else if (!m.is_user) {
            previousReply = clip(m.mes, 600);
            break;
        }
    }
    return playerAction || previousReply ? { playerAction, previousReply } : null;
}

/**
 * The key of a drawn reply: everything that changes what it looks like (job-key.js lists it and its tests
 * prove it). `workflowSig` fingerprints the custom workflow FILE as it was when the job started;
 * `legacy` is the key 1.07 made, so pages saved by 1.07 are still found fresh.
 */
function computeParamsHash(messageText, rawSettings, workflowSig = '', legacy = false) {
    return hashString(JSON.stringify(jobKeyParts(messageText, rawSettings, { pipeline: `${PIPELINE_VERSION}:${WORLD_VERSION}`, workflowSig, legacy })));
}

/** What every page of this chat cost so far, over every attempt (the provider's own figures; null when none reported). */
function chatCostTotal(chat) {
    return chatSpent(chat);
}

function renderPanelFor(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings(context.extensionSettings);
    const message = context.chat[messageId];
    if (!message) return;

    const messageElement = getMessageElement(messageId);
    const revealed = revealOverrides.has(messageId) ? revealOverrides.get(messageId) : settings.revealTextByDefault;

    renderMangaPanel(message, messageElement, {
        revealed,
        inProgress: isJobRunning(context, messageId, message),
        debugEnabled: settings.debug,
        showBubbles: settings.showSpeechBubbles,
        webtoon: Boolean(settings.webtoonMode),
        cost: settings.showCost !== false ? { chatTotal: chatCostTotal(context.chat) } : null,
        // Pictures drawn from another text than the message has now (an edit with automatic drawing off).
        stale: message.extra?.manga?.status === 'done' && Boolean(message.extra.manga.textHash) && message.extra.manga.textHash !== hashString(String(message.mes ?? '')),
        onToggleReveal: (newRevealed) => {
            revealOverrides.set(messageId, newRevealed);
            renderPanelFor(messageId);
        },
        onRetry: () => processMessage(messageId, { force: true }).catch((error) => console.error('[Manga Mode] Unhandled error:', error)),
        onRedraw: () => processMessage(messageId, { force: true, redraw: true }).catch((error) => console.error('[Manga Mode] Unhandled error:', error)),
    });
}

/**
 * Generates (or re-renders cached) manga output for a single message.
 * Never called for bulk chat-load rendering - only from live generation events, swipe navigation,
 * and the manual per-message button - so history is never auto-generated on load.
 */
async function processMessage(messageId, { force = false, redraw = false } = {}) {
    let stopDraws = null;
    const context = SillyTavern.getContext();
    const settings = getSettings(context.extensionSettings);

    if (!settings.enabled) return;

    const message = context.chat[messageId];
    if (!message || message.is_user || message.is_system) return;
    const text = String(message.mes ?? '');
    if (!text.trim()) {
        if (message.extra?.manga) delete message.extra.manga;
        renderPanelFor(messageId);
        return;
    }

    // The workflow file as it is NOW: a later edit in ComfyUI neither changes this job's key nor discards its result.
    const workflowSig = await workflowSignature(settings);
    const hash = computeParamsHash(text, settings, workflowSig);
    const legacyHash = computeParamsHash(text, settings, '', true);
    const swipeId = message.swipe_id ?? 0;
    const chatId = getChatId(context);
    const key = jobKey(chatId, messageId, swipeId, hash);
    if (inFlight.has(key)) return;

    const existing = message.extra?.manga;
    const hasFreshCache = existing?.status === 'done' && (existing.paramsHash === hash || existing.paramsHash === legacyHash);
    if (hasFreshCache && !force) {
        renderPanelFor(messageId);
        return;
    }
    if (!(force || (settings.autoGenerate && !hasFreshCache))) {
        renderPanelFor(messageId);
        return;
    }
    if (!settings.connectionProfileId) {
        toastr.warning('Select a Connection Profile for the Manga Scene Parser in Manga Mode settings.', 'Manga Mode');
        return;
    }

    // "Redraw images": keep this message's storyboard (no director call) and draw it again. Only
    // storyboards from the current director carry the cast the frames are drawn from.
    const keptScene = redraw && existing?.scene?.parserVersion >= 4 && !sceneProblem(existing.scene) ? structuredClone(existing.scene) : null;

    // The last good result stays with the message while a new one is drawn: starting a redraw replaced
    // it with a placeholder, and a failure left only an error (the pictures and their link were lost).
    const lastGood = existing?.status === 'done' ? existing : (existing?.previous || null);
    // What the earlier attempts at this reply cost (a ledger): a redraw adds to it, never replaces it.
    const priorUsage = existing?.status === 'generating' ? (existing.previous?.usage || null) : (existing?.usage || null);
    inFlight.add(key);
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    message.extra.manga = { status: 'generating', paramsHash: hash, startedAt: new Date().toISOString(), ...(lastGood ? { previous: lastGood } : {}) };
    renderPanelFor(messageId);

    let scene = null;
    let result;
    const usage = { parser: [], world: [], vision: [] };
    let identities = [];
    let cast = [];
    try {
        let world = null;
        try {
            const w = await ensureWorldBook(context, settings.connectionProfileId, { reasoningEffort: settings.parserReasoning });
            world = w.world;
            if (w.usage) usage.world.push(w.usage);
        } catch (error) {
            console.warn('[Manga Mode] World book could not be built; drawing without it:', error);
        }
        const knownCast = findKnownCast(context.chat, messageId, world?.cast || [], { personaName: context.name1 });
        const knownSet = findKnownSet(context.chat, messageId);
        const sceneContext = getSceneContext(context, messageId, settings);

        scene = keptScene || await withParserRetry(async () => {
            try {
                const parsed = await parseScene(context, settings.connectionProfileId, text, {
                    characterName: message.name,
                    userName: context.name1,
                    world,
                    knownCast,
                    knownSet,
                    sceneContext,
                    maxPanels: settings.maxPanels,
                    maxImages: settings.maxImages,
                    innerThoughts: settings.innerThoughts,
                    povMode: Boolean(settings.playerPov),
                    reasoningEffort: settings.parserReasoning,
                });
                usage.parser.push(parsed.__usage || null);
                return parsed;
            } catch (error) {
                if (error?.usage) usage.parser.push(error.usage);
                throw error;
            }
        });
        if (settings.debug) console.log('[Manga Mode] Storyboard:', scene);

        cast = uniqueLabels(mergeCast(knownCast, scene.cast));
        // The storyboard as drawn: completed again with the whole cast (people named in the background,
        // the shoulder of an over-the-shoulder view, carried postures), so a redraw of a saved
        // storyboard gets the same logic as a fresh one.
        scene = normalizeScene(scene, { userName: context.name1, cast, povMode: Boolean(settings.playerPov) });
        identities = cast.map((p) => ({ kind: p.name === context.name1 ? 'persona' : 'character', name: p.name, appearance: { physicalTraits: p.look, defaultOutfit: p.outfit } }));
        const setBook = mergeSet(knownSet, scene.places);
        const compileCtx = {
            style: settings.promptStyle,
            presets: settings.promptPresets,
            cast,
            setBook,
            world,
            setting: scene.setting,
            personaName: context.name1,
            povMode: Boolean(settings.playerPov),
        };
        const tools = {
            promptFor: (spec, camera) => compileFrame(spec, camera, compileCtx),
            expectFor: (spec, camera) => frameExpectation(spec, camera, compileCtx),
            labelOf: (name) => findPerson(cast, name)?.label || null,
            nameOf: (label) => cast.find((p) => p.label === label)?.name || null,
            refsFor: async (names) => referencesForFrame(context, settings, names, cast, compileCtx),
            usage,
        };

        const plan = planPanels(scene, {
            maxPanels: settings.maxPanels,
            fullBleedCooldown: settings.fullBleedCooldown,
            sinceFullBleed: messagesSinceFullBleed(context.chat, messageId, 50, pendingFullBleed),
            splitDialogueThreshold: settings.splitDialogueThreshold,
            defaultSize: { width: settings.comfy.width, height: settings.comfy.height },
            maxImages: settings.maxImages,
            playerName: context.name1,
            seed: hash,
            establishingHint: wantsEstablishing(text, sceneContext?.playerAction),
            webtoon: Boolean(settings.webtoonMode),
        });
        if (plan.some((step) => step.fullBleed)) pendingFullBleed.add(message);

        const panels = [];
        const panelErrors = [];
        // The graphics card used to sit idle while each picture was checked (a few seconds, about
        // ten times a page). The pictures are now started two at a time: while one is being
        // checked, the next one draws. Each picture goes through exactly the same steps as before
        // (same prompt, check, redraws, crops) and the page is put together in the same order.
        const draws = startDraws(context, settings, plan, tools);
        tools.draws = draws;
        stopDraws = draws.stop;
        for (const step of plan) {
            const base = { index: step.index, strategy: step.strategy, fromPanel: step.fromPanel, camera: step.camera, fullBleed: step.fullBleed, dialogue: step.dialogue, characters: step.spec?.characters || null, kind: step.spec?.kind || null, sfx: step.frames ? null : (step.spec?.sfx || null), focusSide: step.focusSide || null };
            try {
                if (step.strategy === 'grid') {
                    panels.push(await generateGridPanel(context, settings, step, base, tools, panelErrors));
                } else if (step.strategy === 'generate') {
                    const g = await draws.take(`${step.index}`);
                    panels.push({ ...base, ...g });
                } else {
                    const source = panels.find((p) => p.index === step.fromPanel && p.imageUrl);
                    if (!source) throw new Error('No generated panel to crop from.');
                    const last = source.frames?.length ? source.frames[source.frames.length - 1] : source;
                    panels.push({ ...base, ...await reframe(context, settings, last, { spec: step.spec, camera: step.camera, aspect: null, focusName: step.focusName, focusSide: step.focusSide }, tools) });
                }
            } catch (error) {
                if (!panels.length) throw error;
                console.warn(`[Manga Mode] Panel ${step.index + 1} failed; its lines move to the previous panel:`, error);
                panelErrors.push({ index: step.index, error: describeError(error) });
                const previous = panels[panels.length - 1];
                if (previous.frames?.length) {
                    const lastFrame = previous.frames[previous.frames.length - 1];
                    lastFrame.dialogue = [...(lastFrame.dialogue || []), ...step.dialogue];
                }
                if (Array.isArray(previous.dialogue)) previous.dialogue = [...previous.dialogue, ...step.dialogue];
            }
            showProgress(message, hash, swipeId, scene, panels, plan.length);
        }

        const first = panels[0];
        result = {
            status: 'done',
            paramsHash: hash,
            scene,
            cast,
            world: world ? { summary: world.summary, era_and_technology: world.era_and_technology } : null,
            promptStyle: settings.promptStyle,
            positivePrompt: (first.promptChunks || []).join('\nBREAK\n'),
            negativePrompt: withSafetyNegative(settings.comfy.negativePrompt, settings.comfy.modelNegative),
            modelProfile: settings.customWorkflow?.enabled ? `custom workflow: ${settings.customWorkflow.name}` : (getActiveProfile(settings)?.name || null),
            promptChunks: first.promptChunks,
            imageUrl: first.imageUrl,
            panels,
            panelErrors,
            generation: first.generation,
            identities,
            textHash: hashString(text),
            usage: withLedger(priorUsage, usageSummary(usage, keptScene ? existing?.usage : null)),
            generatedAt: new Date().toISOString(),
        };
    } catch (error) {
        console.error('[Manga Mode] Generation failed:', error);
        result = keepLastGood(lastGood, {
            status: 'error',
            paramsHash: hash,
            scene,
            cast,
            identities,
            usage: withLedger(priorUsage, usageSummary(usage)),
            error: describeError(error),
        });
    } finally {
        inFlight.delete(key);
        stopDraws?.();
    }

    try {
        await commitResult({ chatId, messageRef: message, swipeId, hash, result, workflowSig });
    } finally {
        // Whatever happened (a failure included), this job no longer plans a full-bleed panel: the flag
        // used to stay on the message for the whole session and blocked full-bleed panels around it.
        pendingFullBleed.delete(message);
    }
}

/** What this reply's LLM calls cost, as reported by the provider. Saved with the message. */
function usageSummary(usage, keptParserUsage = null) {
    const parser = keptParserUsage?.parser || addUsage(usage.parser.filter(Boolean));
    const world = addUsage(usage.world.filter(Boolean));
    const vision = addUsage(usage.vision.filter(Boolean));
    const total = addUsage([keptParserUsage ? null : parser, world, vision].filter(Boolean));
    return total || parser ? { parser, world, vision, total, redrawn: Boolean(keptParserUsage) } : null;
}

/** Set when ComfyUI rejects the character-reference nodes (not installed): off for this session. */
let referenceUnavailable = false;

/** Reference pictures for a one-person frame of a cast member (off by default). With a custom
 * workflow they are made only when that workflow takes them (%reference%, e.g. an IP-Adapter). */
async function referencesForFrame(context, settings, names, cast, compileCtx) {
    if (!settings.characterReference || referenceUnavailable) return [];
    if (settings.customWorkflow?.enabled) {
        try {
            if (!wantsReference((await loadCustomWorkflow(settings.comfy.url, settings.customWorkflow.name)).api)) return [];
        } catch { return []; }
    }
    const known = [...new Set((names || []).map((n) => findPerson(cast, n)).filter(Boolean))];
    if (known.length !== 1) return [];
    try {
        const identity = { name: known[0].name, label: known[0].label, appearance: { physicalTraits: known[0].look, defaultOutfit: known[0].outfit }, currentOutfit: known[0].outfit };
        // An IP-Adapter copies the sheet's background too: white sheets gave white skies. The
        // in-context LoRA was trained on white, so white stays for the built-in workflow.
        const background = settings.customWorkflow?.enabled ? 'plain flat mid-grey studio background' : 'plain white studio background';
        return await referencesFor(context, settings, [known[0].name], [identity], {
            promptFor: (sheetScene, spec, camera) => compileFrame(spec, camera, { ...compileCtx, povMode: false, cast: [{ ...known[0] }], setBook: [], setting: background }),
            subFolder: IMAGE_SUBFOLDER,
            maxPeople: 1,
            background,
            checkSheet: settings.qualityCheck ? (url, expectation) => checkFrame(context, settings, url, expectation) : null,
        });
    } catch (error) {
        console.warn('[Manga Mode] Could not prepare character reference pictures:', error);
        return [];
    }
}

/** Generates with reference pictures attached; turns references off if ComfyUI rejects them. */
async function generateWithRefs(context, settings, params, refs) {
    if (!refs?.length) return generatePanelImage(context, params, settings, IMAGE_SUBFOLDER);
    try {
        return await generatePanelImage(context, { ...params, refs }, settings, IMAGE_SUBFOLDER);
    } catch (error) {
        if (!/rejected|not found|Value not in list/i.test(String(error?.message || ''))) throw error;
        referenceUnavailable = true;
        console.warn('[Manga Mode] ComfyUI rejected the character-reference workflow; drawing without references for this session.', error);
        return generatePanelImage(context, params, settings, IMAGE_SUBFOLDER);
    }
}

/**
 * One picture, checked by the vision model and redrawn (new seed) while it is clearly wrong, up to
 * `maxRedraws` times. The best attempt is kept.
 * @returns {Promise<{g: object, check: object|null, attempts: object[]}>}
 */
async function generateChecked(context, settings, { chunks, width, height, expectation, names, vary = null }, tools) {
    const tries = settings.qualityCheck ? 1 + Math.max(0, Number(settings.maxRedraws) || 0) : 1;
    const refs = await tools.refsFor(names);
    let best = null;
    const attempts = [];
    for (let i = 0; i < tries; i++) {
        // A tall canvas sometimes comes back as two stacked panels of the same person (a sequence
        // of actions drawn as a strip). The next seeds then get a square canvas; the caller cuts
        // the result back to the frame's shape.
        const split = attempts.some((a) => (a.reasons || []).some((r) => /drawn \d+ times|panels?\b/i.test(r)));
        if (split && height > width * 1.05) {
            const side = Math.min(1664, Math.max(512, Math.round(Math.sqrt(width * height) / 64) * 64));
            width = side;
            height = side;
        }
        // A new seed alone gives the same composition at CFG 1 (the same wall between two people on 8
        // of 8 seeds): a redraw also changes the prompt (see redrawVariant).
        const v = i > 0 && vary ? vary(i, attempts[attempts.length - 1]) : null;
        const g = await generateWithRefs(context, settings, { chunks: v?.chunks || chunks, width, height }, refs);
        if (!settings.qualityCheck) return { g, check: null, attempts };
        let check = null;
        try {
            check = await checkFrame(context, settings, g.url, v?.expectation || expectation);
            tools.usage.vision.push(check.usage);
            // A failed look is confirmed by a second look at the SAME picture before a redraw is paid for (see confirmVerdict).
            if (!check.pass && settings.confirmChecks !== false) {
                try {
                    const second = await checkFrame(context, settings, g.url, v?.expectation || expectation);
                    tools.usage.vision.push(second.usage);
                    const final = confirmVerdict(check, second);
                    final.looks = { first: check.reasons, second: second.reasons, firstAnswer: settings.debug ? check.answer : undefined };
                    if (settings.debug) console.info('[Manga Mode] Quality check confirmed:', { first: check.reasons, second: second.reasons, final: final.pass ? 'pass' : final.reasons });
                    check = final;
                } catch (error) {
                    console.warn(`[Manga Mode] Confirming look failed; the first verdict stands: ${describeError(error)}`);
                }
            }
        } catch (error) {
            console.warn(`[Manga Mode] Quality check failed; keeping the picture unchecked: ${describeError(error)}`, error);
            return { g, check: null, attempts };
        }
        attempts.push({ url: g.url, pass: check.pass, reasons: check.reasons, seen: check.answer?.seen, score: check.answer?.score,
            // Kept for studying the checker (settings.debug): what it was asked, what it answered, what each look said.
            ...(settings.debug ? { expectation: v?.expectation || expectation, answer: check.answer, looks: check.looks } : {}) });
        const score = (check.pass ? 100 : 0) + (Number(check.answer?.score) || 0) - check.reasons.length;
        if (!best || score > best.score) best = { g, check, score };
        if (check.pass || (!check.major && (i >= 1 || settings.redrawMinor === false))) break;
        if (settings.debug) console.info('[Manga Mode] Frame redrawn:', check.reasons);
    }
    return { g: best.g, check: best.check, attempts };
}

function qualityOf(result) {
    if (!result.check) return null;
    return { pass: result.check.pass, reasons: result.check.reasons, seen: result.check.answer?.seen || '', attempts: result.attempts.length, history: result.attempts };
}

/** Heads as stored with a frame: label, the person's name (for balloon tails) and the box. */
function namedHeads(heads, tools) {
    return (heads || []).map((h) => ({ label: h.label, name: tools.nameOf(h.label), box: h.box }));
}

/**
 * One frame's picture. What is generated and how it is cut is decided in frame-plan.js (pure); this
 * draws it: a close-up of a person is drawn as an upper-body picture and cut to the head the quality
 * check found, a tall narrow frame is drawn wider and cut to shape around the heads.
 */
async function drawBeat(context, settings, { spec, camera, size, aspect, focusName }, tools) {
    const personaName = SillyTavern.getContext().name1;
    const d = drawPlanFor({ spec, camera, size, aspect, focusName }, { personaName });
    if (d.mode === 'closeByCrop') {
        const r = await generateChecked(context, settings, { chunks: tools.promptFor(d.spec, d.camera), width: d.width, height: d.height, expectation: tools.expectFor(d.spec, d.camera), names: d.refNames }, tools);
        const t0 = performance.now();
        const label = tools.labelOf(d.focus);
        const head = r.check ? headOf(r.check.answer, label) : null;
        const shot = d.detailCamera.shot;
        const crop = head
            ? await cropToHead(context, r.g.url, head, { shot, aspect: aspect || null, subFolder: IMAGE_SUBFOLDER })
            : await createCropPanel(context, r.g.url, { side: 'center', shot, subFolder: IMAGE_SUBFOLDER, aspect: aspect || (shot === 'extreme close-up' ? 1.5 : 0.9) });
        const cropAspect = (crop.crop.x1 - crop.crop.x0) / Math.max(1e-6, crop.crop.y1 - crop.crop.y0) * (r.g.width / r.g.height);
        const detailed = await detailPass(context, settings, crop.url, tools.promptFor(d.spec, d.detailCamera), cropAspect, await tools.refsFor([d.focus]));
        const generation = { ...r.g.generation, seconds: Math.round(((r.g.generation?.seconds || 0) + (performance.now() - t0) / 1000) * 10) / 10 };
        return {
            imageUrl: detailed || crop.url, crop: crop.crop, sourceUrl: r.g.url, cropUrl: detailed ? crop.url : undefined, closeUpByCrop: true,
            promptChunks: r.g.promptChunks, generation, width: r.g.width, height: r.g.height,
            heads: r.check ? namedHeads(headsInCrop(r.check.answer, crop.crop), tools) : null, quality: qualityOf(r), croppedBy: head ? 'head box' : 'fallback',
        };
    }
    const chunks = tools.promptFor(d.spec, d.camera);
    const expectation = tools.expectFor(d.spec, d.camera);
    const vary = (attempt, last) => {
        const spec = redrawVariant(d.spec, attempt, last?.reasons);
        return spec === d.spec ? null : { chunks: tools.promptFor(spec, d.camera), expectation: tools.expectFor(spec, d.camera) };
    };
    let r = await generateChecked(context, settings, { chunks, width: d.width, height: d.height, expectation, names: d.refNames, vary }, tools);
    // A hands insert that failed every look is drawn once more as a medium shot of the person (see fallbackFromInsert).
    const fallback = r.check && !r.check.pass && settings.insertFallback !== false ? fallbackFromInsert(d.spec, d.camera) : null;
    if (fallback) {
        try {
            const alt = await generateChecked(context, settings, { chunks: tools.promptFor(fallback.spec, fallback.camera), width: d.width, height: d.height, expectation: tools.expectFor(fallback.spec, fallback.camera), names: d.refNames }, tools);
            const better = alt.check?.pass || (alt.check && (alt.check.answer?.score || 0) > (r.check.answer?.score || 0) && !alt.check.major);
            if (settings.debug) console.info('[Manga Mode] Failed insert redrawn as a medium shot:', { before: r.check.reasons, after: alt.check?.reasons, used: Boolean(better) });
            if (better) r = alt;
        } catch (error) {
            console.warn(`[Manga Mode] Insert fallback failed; keeping the insert: ${describeError(error)}`);
        }
    }
    await touchUpFaces(context, settings, r, { spec: d.spec, camera: d.camera, names: d.refNames }, tools);
    // Every attempt came back on white paper: the white edges are cut off rather than shown as a blank
    // band in the page (the frame's box shows the rest of the drawing, cropped to its shape).
    const paper = r.check?.contentBox;
    if (paper && (r.check.reasons || []).some((x) => /white area|blank background/i.test(x))) {
        try {
            const cutUrl = await cropRegion(context, r.g.url, paper, { subFolder: IMAGE_SUBFOLDER });
            return { imageUrl: cutUrl, crop: paper, sourceUrl: r.g.url, trimmedWhite: true, promptChunks: r.g.promptChunks, generation: r.g.generation, width: r.g.width, height: r.g.height, heads: r.check ? namedHeads(headsInCrop(r.check.answer, paper), tools) : null, quality: qualityOf(r) };
        } catch (error) {
            console.warn('[Manga Mode] Could not trim the white edges; keeping the picture:', error);
        }
    }
    const wanted = d.mode === 'wideCrop' ? aspect : size.width / size.height;
    if (d.mode === 'wideCrop' || Math.abs(r.g.width / r.g.height - wanted) > 0.05) {
        // Cut to the frame's shape around the heads (a tall frame drawn wider, or a square redraw
        // after a two-panel result).
        const heads = r.check ? headsOf(r.check.answer) : [];
        const centerX = heads.length ? (Math.min(...heads.map((h) => h.box.x0)) + Math.max(...heads.map((h) => h.box.x1))) / 2 : 0.5;
        const cut = await cropToAspect(context, r.g.url, { aspect: wanted, centerX, subFolder: IMAGE_SUBFOLDER });
        return { imageUrl: cut.url, crop: cut.crop, sourceUrl: r.g.url, promptChunks: r.g.promptChunks, generation: r.g.generation, width: r.g.width, height: r.g.height, heads: r.check ? namedHeads(headsInCrop(r.check.answer, cut.crop), tools) : null, quality: qualityOf(r) };
    }
    return { imageUrl: r.g.url, promptChunks: r.g.promptChunks, generation: r.g.generation, width: r.g.width, height: r.g.height, heads: r.check ? namedHeads(headsOf(r.check.answer), tools) : null, quality: qualityOf(r) };
}

/**
 * A closer view of the same instant, cut from the frame before it (free): to the focus person's
 * head when the check found it, else by the old image analysis.
 */
async function reframe(context, settings, source, { spec, camera, aspect, focusName, focusSide }, tools) {
    const t0 = performance.now();
    const want = tools.labelOf(focusName);
    // The focus person's own head - never "the first head": with two people in the source that cut
    // a close-up of the wrong one. Without a match (and more than one head) the side decides.
    const head = findByLabel(source.heads, want, (source.heads || []).length === 1);
    const crop = head
        ? await cropToHead(context, source.imageUrl, head.box, { shot: camera.shot, aspect, subFolder: IMAGE_SUBFOLDER })
        : await createCropPanel(context, source.imageUrl, { side: focusSide || 'center', shot: camera.shot, subFolder: IMAGE_SUBFOLDER, aspect });
    const shape = aspect || ((crop.crop.x1 - crop.crop.x0) / Math.max(1e-6, crop.crop.y1 - crop.crop.y0));
    const detailed = await detailPass(context, settings, crop.url, tools.promptFor(spec, camera), shape);
    const heads = (source.heads || []).map((h) => ({ label: h.label, name: h.name, box: h.box }))
        .map((h) => ({ ...h, box: headsInCrop({ heads: [{ label: h.label, box: [h.box.y0 * 1000, h.box.x0 * 1000, h.box.y1 * 1000, h.box.x1 * 1000] }] }, crop.crop)[0]?.box }))
        .filter((h) => h.box);
    return { imageUrl: detailed || crop.url, crop: crop.crop, cropUrl: detailed ? crop.url : undefined, heads, generation: { attempts: 0, timeouts: 0, seconds: Math.round((performance.now() - t0) / 100) / 10 } };
}

/**
 * Re-draws a cropped (scaled-up, soft) image at full resolution with a light img2img pass. Returns
 * the new image URL, or null when the pass is off or fails (the crop is then used as it is).
 */
async function detailPass(context, settings, imageUrl, chunks, aspect, refs = null) {
    if (settings.detailPass === false) return null;
    try {
        // The person's reference goes into the detail pass too, or it would redraw the face freely.
        const r = await refinePanelImage(context, { imageUrl, chunks, aspect, refs }, settings, IMAGE_SUBFOLDER);
        return r.url;
    } catch (error) {
        console.warn('[Manga Mode] Detail pass failed; using the plain crop:', error);
        return null;
    }
}

/**
 * One panel made of several frames in a manga layout. A frame marked as a closer look at the same
 * instant is cut from the frame before it (free). A frame that fails is left out: its lines move to
 * a neighbour and the panel is laid out again with the frames that exist.
 */
/**
 * Two or more people in a frame: one reference picture would pull every face toward it, so the
 * frame is drawn without one, and then each person's face is redrawn lightly from their own
 * reference (a square around the head the check found, img2img at low strength) and blended back
 * with soft edges. Changes r.g.url in place; any failure leaves the picture as it was.
 */
// 0.42 barely moved a wrong face; 0.65 started changing the pose and hands (tested on one face).
const FACE_TOUCH_DENOISE = 0.55;
async function touchUpFaces(context, settings, r, { spec, camera, names }, tools) {
    const people = [...new Set(names || [])];
    if (settings.faceTouchUp !== true || !settings.characterReference || !r?.check?.answer || people.length < 2) return;
    console.debug('[Manga Mode] Face touch-up for', people.join(', '));
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    let url = r.g.url;
    const t0 = performance.now();
    let touched = 0;
    for (const name of people) {
        try {
            const label = tools.labelOf(name);
            const head = label ? headOf(r.check.answer, label) : null;
            // A face too small to see does not need it; a big one is already its own frame.
            if (!head || (head.y1 - head.y0) < 0.06) { console.debug('[Manga Mode] Face touch-up skipped (no or tiny head):', name, label); continue; }
            const refs = await tools.refsFor([name]);
            if (!refs?.length) { console.debug('[Manga Mode] Face touch-up skipped (no reference):', name); continue; }
            const rect = faceRegion(head, r.g.width / r.g.height);
            const cropUrl = await cropRegion(context, url, rect, { subFolder: IMAGE_SUBFOLDER });
            const solo = { ...spec, kind: 'character', characters: [name], people: (spec.people || []).filter((p) => same(p?.name, name)), background: '', interaction: '' };
            const chunks = tools.promptFor(solo, { shot: 'close-up', angle: camera?.angle === 'pov' || camera?.angle === 'over the shoulder' ? 'eye level' : (camera?.angle || 'eye level') });
            const redrawn = await refinePanelImage(context, { imageUrl: cropUrl, chunks, aspect: 1, denoise: FACE_TOUCH_DENOISE, refs, pixels: 768 * 768 }, settings, IMAGE_SUBFOLDER);
            url = await pasteRegion(context, url, redrawn.url, rect, { subFolder: IMAGE_SUBFOLDER });
            touched++;
        } catch (error) {
            console.warn('[Manga Mode] Face touch-up failed; keeping this face as drawn:', error);
        }
    }
    if (touched) {
        r.g = { ...r.g, url, faceTouchUp: touched, generation: { ...r.g.generation, seconds: Math.round(((r.g.generation?.seconds || 0) + (performance.now() - t0) / 1000) * 10) / 10 } };
    }
}

/** How many pictures are in progress at once: one drawing while the one before is checked. */
const DRAW_AHEAD = 2;

/**
 * Starts the drawn frames of a plan in order, at most DRAW_AHEAD at a time, and hands each result
 * over by key when the page is put together ("3" = panel 3, "3.1" = frame 1 of panel 3). Frames
 * cut from another frame (reframe, crop) are not drawn here. `stop` cancels the ones not started.
 */
function startDraws(context, settings, plan, tools) {
    const jobs = [];
    for (const step of plan) {
        if (step.strategy === 'grid') {
            for (const fr of step.frames) {
                if (fr.strategy === 'reframe') continue;
                jobs.push({ key: `${step.index}.${fr.frame}`, args: { spec: fr.spec, camera: fr.camera, size: fr.size, aspect: fr.rect.aspect, focusName: fr.focusName } });
            }
        } else if (step.strategy === 'generate') {
            jobs.push({ key: `${step.index}`, args: { spec: step.spec, camera: step.camera, size: step.size, aspect: null, focusName: step.focusName } });
        }
    }
    let stopped = false;
    const results = new Map();
    jobs.forEach((job, i) => {
        const gate = i >= DRAW_AHEAD ? results.get(jobs[i - DRAW_AHEAD].key).catch(() => {}) : Promise.resolve();
        const run = gate.then(() => {
            if (stopped) throw new Error('Drawing stopped.');
            return drawBeat(context, settings, job.args, tools);
        });
        run.catch(() => {}); // handled where the page takes it
        results.set(job.key, run);
    });
    return {
        take: (key) => results.get(key) || Promise.reject(new Error(`No drawing was started for frame ${key}.`)),
        stop: () => { stopped = true; },
    };
}

async function generateGridPanel(context, settings, step, base, tools, panelErrors) {
    const frames = [];
    let seconds = 0;
    let attempts = 0;
    let timeouts = 0;
    let orphanLines = [];
    for (const fr of step.frames) {
        const entry = { frame: fr.frame, strategy: fr.strategy, rect: fr.rect, camera: fr.camera, dialogue: [...orphanLines, ...(fr.dialogue || [])], characters: fr.spec?.characters || null, kind: fr.spec?.kind || null, emphasis: fr.spec?.emphasis || null, sfx: fr.spec?.sfx || null, focusSide: fr.focusSide || null };
        orphanLines = [];
        try {
            if (fr.strategy === 'reframe') {
                const source = frames[frames.length - 1];
                if (!source) throw new Error('No frame to crop from.');
                const g = await reframe(context, settings, source, { spec: fr.spec, camera: fr.camera, aspect: fr.rect.aspect, focusName: fr.focusName, focusSide: fr.focusSide }, tools);
                seconds += g.generation.seconds;
                frames.push({ ...entry, ...g });
            } else {
                const g = await tools.draws.take(`${step.index}.${fr.frame}`);
                seconds += g.generation?.seconds || 0;
                attempts += g.generation?.attempts || 0;
                timeouts += g.generation?.timeouts || 0;
                frames.push({ ...entry, ...g });
            }
        } catch (error) {
            console.warn(`[Manga Mode] Panel ${step.index + 1}, frame ${fr.frame + 1} failed; its lines move to a neighbouring frame:`, error);
            panelErrors.push({ index: step.index, frame: fr.frame, error: describeError(error) });
            const previous = frames[frames.length - 1];
            if (previous) previous.dialogue = [...previous.dialogue, ...entry.dialogue];
            else orphanLines = entry.dialogue;
        }
    }
    if (orphanLines.length && frames.length) frames[frames.length - 1].dialogue.push(...orphanLines);
    if (!frames.length) throw new Error('Every frame of this panel failed.');
    const generation = { attempts, timeouts, seconds: Math.round(seconds * 10) / 10 };
    if (frames.length === 1) {
        const only = frames[0];
        return { ...base, strategy: 'generate', dialogue: only.dialogue, imageUrl: only.imageUrl, promptChunks: only.promptChunks, generation, width: only.width, height: only.height, heads: only.heads, quality: only.quality };
    }
    let layout = step.layout;
    if (frames.length < step.frames.length) {
        const again = chooseLayout(frames.map((f) => ({ kind: f.kind, people: (f.characters || []).length, shot: f.camera?.shot, emphasis: f.emphasis })), { seed: base.index });
        frames.forEach((f, i) => { f.rect = again.frames[i]; });
        layout = { template: again.template, aspect: again.aspect };
    }
    return { ...base, strategy: 'grid', layout, frames, dialogue: frames.flatMap((f) => f.dialogue), imageUrl: frames[0].imageUrl, promptChunks: frames[0].promptChunks, generation };
}

/**
 * The scene parser's API (Gemini through a Connection Profile) intermittently answers
 * "503 - model experiencing high demand", surfaced by SillyTavern as "API request failed".
 * Two automatic retries with growing pauses recover most of these; a third failure is shown.
 */
const PARSER_RETRY_DELAYS_MS = [4000, 10000];

async function withParserRetry(call) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await call();
        } catch (error) {
            // A wrong key, no credit or a rejected setting never passes by itself: show the real reason at once
            // instead of waiting 14 s and failing the same way. Busy / rate-limit / network errors are retried.
            if (attempt >= PARSER_RETRY_DELAYS_MS.length || !isTransientError(error)) throw error;
            const delay = PARSER_RETRY_DELAYS_MS[attempt];
            console.warn(`[Manga Mode] Scene parser request failed - retry ${attempt + 1}/${PARSER_RETRY_DELAYS_MS.length} in ${delay / 1000} s: ${describeError(error)}`);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}

/**
 * Phase 4: shows the panels finished so far while the rest of the reply's panels generate - only
 * if the message still shows the text/swipe this job is drawing.
 */
function showProgress(message, hash, swipeId, scene, panels, total) {
    const manga = message.extra?.manga;
    if (!manga || manga.status !== 'generating' || manga.paramsHash !== hash || (message.swipe_id ?? 0) !== swipeId) return;
    manga.scene = scene;
    manga.partialPanels = panels.slice();
    manga.progress = { done: panels.length, total };
    const messageId = SillyTavern.getContext().chat.indexOf(message);
    if (messageId >= 0) renderPanelFor(messageId);
}

/**
 * Writes a finished job's result back - but only where it still belongs. While the job ran, the
 * user may have swiped, edited the message, deleted messages above it, or switched chats; writing
 * blindly into `message.extra` (a fresh object after every swipe) is what produced stale panels.
 */
async function commitResult({ chatId, messageRef, swipeId, hash, result, workflowSig = '' }) {
    const context = SillyTavern.getContext();
    const settings = getSettings(context.extensionSettings);

    if (getChatId(context) !== chatId) {
        console.info('[Manga Mode] Chat changed while a panel was generating; result discarded.');
        return;
    }
    const messageId = context.chat.indexOf(messageRef);
    if (messageId < 0) {
        console.info('[Manga Mode] Message was deleted while its panel was generating; result discarded.');
        return;
    }

    const currentSwipe = messageRef.swipe_id ?? 0;
    const stillSame = currentSwipe === swipeId && computeParamsHash(String(messageRef.mes ?? ''), settings, workflowSig) === hash;

    if (stillSame) {
        if (!messageRef.extra || typeof messageRef.extra !== 'object') messageRef.extra = {};
        messageRef.extra.manga = result;
        // SillyTavern keeps a separate per-swipe copy of `extra` (swipe_info) that it snapshotted
        // while our placeholder was up; without this, swiping away and back restores "generating".
        const info = messageRef.swipe_info?.[swipeId];
        if (info && typeof info === 'object') {
            if (!info.extra || typeof info.extra !== 'object') info.extra = {};
            info.extra.manga = result;
        }
        renderPanelFor(messageId);
    } else {
        // The result belongs to a swipe that is no longer shown: file it with that swipe, if its text
        // is still the one we drew, so swiping back shows it instead of regenerating.
        const info = messageRef.swipe_info?.[swipeId];
        const swipeText = messageRef.swipes?.[swipeId];
        if (currentSwipe !== swipeId && info && typeof info === 'object' && typeof swipeText === 'string'
            && computeParamsHash(swipeText, settings, workflowSig) === hash) {
            if (!info.extra || typeof info.extra !== 'object') info.extra = {};
            info.extra.manga = result;
        }
        if (settings.debug) {
            console.info('[Manga Mode] Message changed while its panel was generating; not showing the outdated result.', { messageId, swipeId, currentSwipe });
        }
        // Clear our own placeholder if it is still showing, then handle whatever is current now.
        if (messageRef.extra?.manga?.status === 'generating' && messageRef.extra.manga.paramsHash === hash) {
            delete messageRef.extra.manga;
        }
        processMessage(messageId).catch((error) => console.error('[Manga Mode] Unhandled error:', error));
    }

    try {
        await context.saveChat();
    } catch (error) {
        console.error('[Manga Mode] Failed to save chat after generation:', error);
    }
}

// Console/debug hook: MangaMode.redraw(messageId) redraws a message's panels from its saved scene.
globalThis.MangaMode = Object.assign(globalThis.MangaMode || {}, {
    redraw: (messageId) => processMessage(Number(messageId), { force: true, redraw: true }),
    regenerate: (messageId) => processMessage(Number(messageId), { force: true }),
});

function refreshVisibleMessages() {
    const context = SillyTavern.getContext();
    $('#chat').find('.mes').each(function () {
        const mesIdAttr = $(this).attr('mesid');
        if (!mesIdAttr) return;
        const messageId = Number(mesIdAttr);
        if (Number.isNaN(messageId) || !context.chat[messageId]) return;
        if (context.chat[messageId].is_user || context.chat[messageId].is_system) return;
        injectMangaButton($(this));
        renderPanelFor(messageId);
    });
}

async function loadSettingsUi(context, settings) {
    const template = await context.renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
    $('#extensions_settings2').append(template);

    // Controls that only make sense next to another one follow it: no dead switches.
    const syncDependent = () => {
        const custom = Boolean(settings.customWorkflow?.enabled);
        const split = settings.comfy.family === WORKFLOW_FAMILIES.SPLIT;
        $('#manga_max_redraws').prop('disabled', !settings.qualityCheck);
        $('#manga_redraws_row').toggleClass('manga_dim', !settings.qualityCheck);
        $('#manga_vision_model').prop('disabled', !settings.qualityCheck);
        $('#manga_reference_fields').toggle(settings.characterReference === true);
        $('#manga_face_touch_up').prop('disabled', settings.characterReference !== true).closest('label').toggleClass('manga_dim', settings.characterReference !== true);
        $('#manga_ip_row, #manga_ip_adapter_strength').toggle(custom);
        $('#manga_reference_lora').prev('label').toggle(!custom);
        $('#manga_reference_lora').toggle(!custom);
        $('#manga_builtin_fields').toggle(!custom);
        $('#manga_split_fields').toggle(split);
        $('#manga_checkpoint_fields').toggle(!split);
    };

    $('#manga_enabled').prop('checked', settings.enabled).on('change', function () {
        settings.enabled = $(this).is(':checked');
        context.saveSettingsDebounced();
    });
    $('#manga_auto_generate').prop('checked', settings.autoGenerate).on('change', function () {
        settings.autoGenerate = $(this).is(':checked');
        context.saveSettingsDebounced();
    });
    $('#manga_reveal_default').prop('checked', settings.revealTextByDefault).on('change', function () {
        settings.revealTextByDefault = $(this).is(':checked');
        context.saveSettingsDebounced();
    });
    $('#manga_show_bubbles').prop('checked', settings.showSpeechBubbles).on('change', function () {
        settings.showSpeechBubbles = $(this).is(':checked');
        context.saveSettingsDebounced();
        refreshVisibleMessages();
    });
    $('#manga_debug').prop('checked', settings.debug).on('change', function () {
        settings.debug = $(this).is(':checked');
        context.saveSettingsDebounced();
        refreshVisibleMessages();
    });
    $('#manga_scene_context').prop('checked', settings.sceneContext).on('change', function () {
        settings.sceneContext = $(this).is(':checked');
        context.saveSettingsDebounced();
    });
    $('#manga_max_panels').val(settings.maxPanels).on('input', function () {
        settings.maxPanels = Math.min(10, Math.max(1, Number($(this).val()) || 1));
        context.saveSettingsDebounced();
    });
    $('#manga_max_images').val(settings.maxImages).on('input', function () {
        settings.maxImages = Math.min(16, Math.max(1, Number($(this).val()) || 1));
        context.saveSettingsDebounced();
    });
    $('#manga_character_reference').prop('checked', settings.characterReference !== false).on('change', function () {
        settings.characterReference = Boolean($(this).prop('checked'));
        syncDependent();
        context.saveSettingsDebounced();
    });
    $('#manga_reference_lora').val(settings.referenceLora || '').on('input', function () {
        settings.referenceLora = String($(this).val()).trim();
        context.saveSettingsDebounced();
    });
    $('#manga_reset_references').on('click', function () {
        settings.referenceSheets = {};
        resetReferenceFailures(); // looks that failed three times this session get a fresh try too
        context.saveSettingsDebounced();
        toastr.info('New reference pictures will be drawn the next time each character appears.');
    });
    $('#manga_detail_pass').prop('checked', settings.detailPass !== false).on('change', function () {
        settings.detailPass = Boolean($(this).prop('checked'));
        context.saveSettingsDebounced();
    });
    $('#manga_player_pov').prop('checked', Boolean(settings.playerPov)).on('change', function () {
        settings.playerPov = $(this).is(':checked');
        context.saveSettingsDebounced();
    });
    $('#manga_webtoon_mode').prop('checked', Boolean(settings.webtoonMode)).on('change', function () {
        settings.webtoonMode = $(this).is(':checked');
        context.saveSettingsDebounced();
        refreshVisibleMessages(); // pages already drawn are shown in the new style at once (no redraw needed)
    });
    $('#manga_show_cost').prop('checked', settings.showCost !== false).on('change', function () {
        settings.showCost = $(this).is(':checked');
        context.saveSettingsDebounced();
        refreshVisibleMessages();
    });
    $('#manga_inner_thoughts').prop('checked', settings.innerThoughts).on('change', function () {
        settings.innerThoughts = $(this).is(':checked');
        context.saveSettingsDebounced();
    });
    $('#manga_parser_reasoning').val(settings.parserReasoning).on('change', function () {
        settings.parserReasoning = String($(this).val());
        context.saveSettingsDebounced();
    });
    $('#manga_rebuild_world').on('click', async function () {
        const ctx = SillyTavern.getContext();
        if (!settings.connectionProfileId) return toastr.warning('Select a Connection Profile first.', 'Manga Mode');
        toastr.info('Reading the card, persona and lorebook...', 'Manga Mode');
        try {
            const w = await ensureWorldBook(ctx, settings.connectionProfileId, { reasoningEffort: settings.parserReasoning, force: true });
            toastr.success(`World book rebuilt: ${w.world?.cast?.length || 0} people, ${w.world?.dress_by_role?.length || 0} dress rules.`, 'Manga Mode');
        } catch (error) {
            toastr.error(`World book failed: ${error?.message || error}`, 'Manga Mode');
        }
    });
    $('#manga_show_world').on('click', async function () {
        const world = SillyTavern.getContext().chatMetadata?.mangaWorld?.world;
        const html = world ? `<pre style="white-space:pre-wrap;text-align:left;max-height:70vh;overflow:auto">${$('<div>').text(JSON.stringify(world, null, 2)).html()}</pre>` : 'No world book yet for this chat - it is built with the first panel.';
        await SillyTavern.getContext().Popup.show.text('World book of this chat', html);
    });
    $('#manga_face_touch_up').prop('checked', settings.faceTouchUp === true).on('change', function () {
        settings.faceTouchUp = Boolean($(this).prop('checked'));
        context.saveSettingsDebounced();
    });
    $('#manga_quality_check').prop('checked', settings.qualityCheck !== false).on('change', function () {
        settings.qualityCheck = $(this).is(':checked');
        syncDependent();
        context.saveSettingsDebounced();
    });
    $('#manga_vision_model').val(settings.visionModel || '').on('input', function () {
        settings.visionModel = String($(this).val()).trim();
        context.saveSettingsDebounced();
    });
    $('#manga_max_redraws').val(settings.maxRedraws).on('input', function () {
        settings.maxRedraws = Math.min(5, Math.max(0, Number($(this).val()) || 0));
        context.saveSettingsDebounced();
    });
    $('#manga_comfy_timeout').val(settings.comfy.timeoutSeconds || 300).on('input', function () {
        settings.comfy.timeoutSeconds = Math.min(1800, Math.max(30, Number($(this).val()) || 300));
        context.saveSettingsDebounced();
    });
    // The workflow list: the built-in workflow, plus every workflow the user saved in ComfyUI (through the
    // MangaMode bridge). Nothing is picked until the user has one: the first run picks it for them once.
    const refreshWorkflowList = async () => {
        const select = $('#manga_custom_workflow_name');
        const status = $('#manga_custom_workflow_status');
        let names = [];
        let problem = '';
        try {
            names = await listCustomWorkflows();
        } catch (error) {
            problem = error?.message || String(error);
        }
        const cw = settings.customWorkflow || (settings.customWorkflow = { enabled: false, name: '' });
        if (!cw.userChoice && !cw.name && names.length) {
            Object.assign(cw, { enabled: true, name: names[0] }); // first run: the user's own workflow becomes the default
            context.saveSettingsDebounced();
        }
        select.empty().append($('<option>', { value: '' }).text('Built-in workflow (set up under Advanced settings)'));
        for (const name of names) select.append($('<option>', { value: name }).text(name));
        if (cw.name && !names.includes(cw.name)) select.append($('<option>', { value: cw.name }).text(`${cw.name} (not found in ComfyUI)`));
        select.val(cw.enabled ? cw.name : '');
        syncDependent();
        status.text(problem && !names.length ? 'No ComfyUI workflows found yet. Using the built-in workflow. To use your own, install the ComfyUI-MangaMode-Bridge add-on, save a workflow in ComfyUI (Ctrl+S) and press the refresh button.' : await customWorkflowStatus(settings));
    };
    $('#manga_custom_workflow_name').on('change', function () {
        const name = String($(this).val() ?? '');
        settings.customWorkflow = { ...(settings.customWorkflow || {}), enabled: Boolean(name), name: name || settings.customWorkflow?.name || '', userChoice: true };
        syncDependent();
        context.saveSettingsDebounced();
        refreshWorkflowList();
    });
    $('#manga_custom_workflow_refresh').on('click', refreshWorkflowList);
    const showIpStrength = () => $('#manga_ip_adapter_strength_value').text(Number(settings.ipAdapterStrength ?? 0.6).toFixed(2));
    $('#manga_ip_adapter_strength').val(settings.ipAdapterStrength ?? 0.6).on('input', function () {
        settings.ipAdapterStrength = Math.min(1.2, Math.max(0, Number($(this).val())));
        showIpStrength();
        context.saveSettingsDebounced();
    });
    showIpStrength();
    refreshWorkflowList();
    // One prefix/suffix pair, for the way of writing that is chosen.
    const PROMPT_STYLE_HINTS = {
        tags: 'A comma-separated tag list: Illustrious, NoobAI, other SDXL anime models.',
        tags_pony: 'Tag list that starts with score_9, score_8_up ...: Pony models.',
        natural: 'Plain sentences: Flux, Qwen-Image, Z-Image, Anima and other models with an LLM text encoder.',
    };
    const showPromptStyle = () => {
        const preset = settings.promptPresets[settings.promptStyle] || { prefix: '', suffix: '' };
        $('#manga_prompt_style').val(settings.promptStyle);
        $('#manga_prompt_style_hint').text(PROMPT_STYLE_HINTS[settings.promptStyle] || '');
        $('#manga_prompt_prefix').val(preset.prefix);
        $('#manga_prompt_suffix').val(preset.suffix);
    };
    $('#manga_prompt_style').on('change', function () {
        settings.promptStyle = String($(this).val());
        showPromptStyle();
        context.saveSettingsDebounced();
    });
    $('#manga_prompt_prefix').on('input', function () {
        settings.promptPresets[settings.promptStyle].prefix = String($(this).val());
        context.saveSettingsDebounced();
    });
    $('#manga_prompt_suffix').on('input', function () {
        settings.promptPresets[settings.promptStyle].suffix = String($(this).val());
        context.saveSettingsDebounced();
    });
    showPromptStyle();

    // Model profiles: pick one to fill the ComfyUI fields and the Prompt Style from it.
    const comfyFields = {
        checkpoint: '#manga_comfy_checkpoint', sampler: '#manga_comfy_sampler', scheduler: '#manga_comfy_scheduler',
        steps: '#manga_comfy_steps', cfg: '#manga_comfy_cfg', width: '#manga_comfy_width', height: '#manga_comfy_height',
        family: '#manga_comfy_family', unet: '#manga_comfy_unet', unetDtype: '#manga_comfy_unet_dtype', clip: '#manga_comfy_clip',
        clipType: '#manga_comfy_clip_type', vae: '#manga_comfy_vae', modelNegative: '#manga_comfy_model_negative',
        loras: '#manga_comfy_loras',
    };
    const refreshComfyFields = () => {
        for (const [key, selector] of Object.entries(comfyFields)) $(selector).val(settings.comfy[key] ?? '');
        showPromptStyle();
        syncDependent();
    };
    const refreshProfiles = () => {
        const select = $('#manga_model_profile').empty();
        for (const profile of settings.modelProfiles) {
            select.append($('<option>', { value: profile.id }).text(`${profile.name} - ${profile.promptStyle}`));
        }
        select.val(settings.activeProfileId);
    };
    refreshProfiles();
    $('#manga_model_profile').on('change', function () {
        const profile = settings.modelProfiles.find((p) => p.id === $(this).val());
        applyProfile(settings, profile);
        refreshComfyFields();
        context.saveSettingsDebounced();
        toastr.info(`Model profile "${profile?.name}" applied (Prompt Style: ${settings.promptStyle}).`, 'Manga Mode');
    });
    $('#manga_model_profile_save').on('click', function () {
        const active = getActiveProfile(settings);
        if (!active) return;
        upsertProfile(settings, { ...profileFromSettings(settings, { id: active.id, name: active.name, notes: active.notes }) });
        refreshProfiles();
        context.saveSettingsDebounced();
        toastr.success(`Saved into "${active.name}".`, 'Manga Mode');
    });
    $('#manga_model_profile_new').on('click', async function () {
        const name = await context.Popup.show.input('New model profile', 'Name for this model profile (e.g. "Anima Base 1.0 (natural)")', '');
        if (!name) return;
        const profile = profileFromSettings(settings, { name: String(name) });
        if (settings.modelProfiles.some((p) => p.id === profile.id)) profile.id = `${profile.id}-${Date.now()}`;
        upsertProfile(settings, profile);
        settings.activeProfileId = profile.id;
        refreshProfiles();
        context.saveSettingsDebounced();
    });
    $('#manga_comfy_family').on('change', function () {
        settings.comfy.family = String($(this).val());
        syncDependent();
        context.saveSettingsDebounced();
    });
    for (const key of ['unet', 'clip', 'clipType', 'vae', 'modelNegative', 'loras']) {
        $(comfyFields[key]).on('input', function () {
            settings.comfy[key] = String($(this).val());
            context.saveSettingsDebounced();
        });
    }
    $('#manga_comfy_unet_dtype').on('change', function () {
        settings.comfy.unetDtype = String($(this).val());
        context.saveSettingsDebounced();
    });
    refreshComfyFields();

    $('#manga_comfy_url').val(settings.comfy.url).on('input', function () {
        settings.comfy.url = String($(this).val());
        context.saveSettingsDebounced();
    });
    $('#manga_comfy_checkpoint').val(settings.comfy.checkpoint).on('input', function () {
        settings.comfy.checkpoint = String($(this).val());
        context.saveSettingsDebounced();
    });
    $('#manga_comfy_sampler').val(settings.comfy.sampler).on('input', function () {
        settings.comfy.sampler = String($(this).val());
        context.saveSettingsDebounced();
    });
    $('#manga_comfy_scheduler').val(settings.comfy.scheduler).on('input', function () {
        settings.comfy.scheduler = String($(this).val());
        context.saveSettingsDebounced();
    });
    $('#manga_comfy_steps').val(settings.comfy.steps).on('input', function () {
        settings.comfy.steps = Number($(this).val()) || settings.comfy.steps;
        context.saveSettingsDebounced();
    });
    $('#manga_comfy_cfg').val(settings.comfy.cfg).on('input', function () {
        settings.comfy.cfg = Number($(this).val()) || settings.comfy.cfg;
        context.saveSettingsDebounced();
    });
    $('#manga_comfy_width').val(settings.comfy.width).on('input', function () {
        settings.comfy.width = Number($(this).val()) || settings.comfy.width;
        context.saveSettingsDebounced();
    });
    $('#manga_comfy_height').val(settings.comfy.height).on('input', function () {
        settings.comfy.height = Number($(this).val()) || settings.comfy.height;
        context.saveSettingsDebounced();
    });
    $('#manga_comfy_negative').val(settings.comfy.negativePrompt).on('input', function () {
        settings.comfy.negativePrompt = String($(this).val());
        context.saveSettingsDebounced();
    });

    $('#manga_comfy_fetch_models').on('click', async function () {
        try {
            const response = await fetch('/api/sd/comfy/models', {
                method: 'POST',
                headers: context.getRequestHeaders(),
                body: JSON.stringify({ url: settings.comfy.url }),
            });
            if (!response.ok) throw new Error(await response.text());
            const models = await response.json();
            const datalist = $('#manga_comfy_checkpoint_list').empty();
            for (const model of models) {
                datalist.append($('<option>', { value: model.value }).text(model.text));
            }
            toastr.success(`Found ${models.length} checkpoint(s).`, 'Manga Mode');
        } catch (error) {
            toastr.error('Could not reach ComfyUI. Check the server URL.', 'Manga Mode');
            console.error('[Manga Mode] Failed to fetch ComfyUI models:', error);
        }
    });

    context.ConnectionManagerRequestService.handleDropdown(
        '#manga_connection_profile',
        settings.connectionProfileId,
        (profile) => {
            settings.connectionProfileId = profile?.id || '';
            context.saveSettingsDebounced();
        },
    );
}

export async function init() {
    const context = SillyTavern.getContext();
    const settings = getSettings(context.extensionSettings);

    await loadSettingsUi(context, settings);

    context.eventSource.on(context.eventTypes.CHARACTER_MESSAGE_RENDERED, (messageId) => {
        const id = Number(messageId);
        injectMangaButton(getMessageElement(id));
        processMessage(id).catch((error) => console.error('[Manga Mode] Unhandled error:', error));
    });

    context.eventSource.on(context.eventTypes.MESSAGE_SWIPED, (messageId) => {
        const id = Number(messageId);
        injectMangaButton(getMessageElement(id));
        renderPanelFor(id);
    });

    // An edited message must not keep showing the panel drawn for its old text.
    context.eventSource.on(context.eventTypes.MESSAGE_EDITED, (messageId) => {
        const id = Number(messageId);
        processMessage(id).catch((error) => console.error('[Manga Mode] Unhandled error:', error));
    });

    context.eventSource.on(context.eventTypes.MESSAGE_DELETED, () => {
        setTimeout(refreshVisibleMessages, 0);
    });

    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
        revealOverrides.clear();
        setTimeout(refreshVisibleMessages, 0);
    });

    context.eventSource.on(context.eventTypes.MORE_MESSAGES_LOADED, () => {
        setTimeout(refreshVisibleMessages, 0);
    });

    $(document).on('click', `.${BUTTON_CLASS}`, function () {
        const messageId = Number($(this).closest('.mes').attr('mesid'));
        if (!Number.isNaN(messageId)) {
            processMessage(messageId, { force: true }).catch((error) => console.error('[Manga Mode] Unhandled error:', error));
        }
    });

    refreshVisibleMessages();
}
