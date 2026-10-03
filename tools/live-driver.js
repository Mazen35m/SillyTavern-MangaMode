// Paste into the browser console (or run through a browser tool) of the SillyTavern tab at http://127.0.0.1:8000/
// It sends player messages one after another, waits for the reply AND the finished pictures, and records per-turn stats.
// LESSONS (all cost me time):
//  - The tab must be VISIBLE (own window). A hidden tab is throttled by Chrome: timers stall, screenshots fail.
//  - Never refresh the page (Ctrl+F5): the driver lives in the page and dies; the chat itself is saved.
//  - selectCharacterById() can silently fail: always verify the active character before sending.
//  - Browser-tool calls time out after about 2 minutes: poll with short waits.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
window.__turns = []; window.__abort = null; window.__stopQueue = false; window.__critiques = {};

// Keeps timers alive while the tab is in the background (loopback WebRTC data channel). Helps, does not replace a visible window.
(async () => { const a = new RTCPeerConnection(), b = new RTCPeerConnection(); a.onicecandidate = e => e.candidate && b.addIceCandidate(e.candidate); b.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate); const ch = a.createDataChannel('k'); b.ondatachannel = e => { e.channel.onmessage = () => {}; }; const o = await a.createOffer(); await a.setLocalDescription(o); await b.setRemoteDescription(o); const n = await b.createAnswer(); await b.setLocalDescription(n); await a.setRemoteDescription(n); window.__keepalive = { a, b, ch, t: setInterval(() => { try { ch.readyState === 'open' && ch.send('k'); } catch {} }, 5000) }; })();

// Gemini as a webtoon editor, called through SillyTavern's own connection (no key needed in the page).
window.__critique = async (msgIndex, model = 'google/gemini-3.8-flash') => {
  const c = SillyTavern.getContext(); const vc = await import('/scripts/extensions/third-party/SillyTavern-MangaMode/vision-check.js');
  const m = c.chat[msgIndex]; const g = m.extra.manga;
  const content = [{ type: 'text', text: `You are a senior webtoon/manhwa editor. Below are the ${g.panels.length} consecutive pictures of ONE vertical-scroll reader experience (top to bottom), drawn for this roleplay reply (the reader IS the player, seen in first person):\n\n"""${m.mes.slice(0, 1800)}"""\n\nEvaluate honestly and concretely as a reader, not politely:\n1. Immersion 1-10 and why. 2. Camera/direction: variety, repetition, confusion. 3. Expressions/acting. 4. Environment interaction. 5. The single most valuable change. Max 200 words. Start with "SCORE: n/10".` }];
  for (const p of g.panels) content.push({ type: 'image_url', image_url: { url: await vc.imageDataUrl(p.imageUrl, 640) } });
  const r = await c.ConnectionManagerRequestService.sendRequest(c.extensionSettings.mangaMode.connectionProfileId, [{ role: 'user', content }], 1500, { includePreset: false, includeInstruct: false, extractData: false }, { model, reasoning_effort: 'low' });
  return { text: r?.choices?.[0]?.message?.content, cost: r?.usage?.cost };
};

window.__mmTurn = (label, text, expectChar) => {
  const rec = { label, text, state: 'sending', t0: Date.now() }; window.__turns.push(rec);
  (async () => { try {
    const c = SillyTavern.getContext();
    if (c.characters[c.characterId]?.name !== expectChar) { rec.state = 'error'; rec.err = 'WRONG CHARACTER: ' + c.characters[c.characterId]?.name; return; }
    const before = c.chat.length; const ta = document.querySelector('#send_textarea'); ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#send_but').click();
    rec.state = 'waiting-reply'; const t = Date.now();
    while (Date.now() - t < 300000) { await sleep(1500); const ch = SillyTavern.getContext().chat; const last = ch[ch.length - 1];
      if (ch.length >= before + 2 && !last.is_user && last.mes && !document.querySelector('#mes_stop')?.offsetParent) { rec.state = 'waiting-manga'; const g = last.extra?.manga; if (g && (g.status === 'done' || g.status === 'error')) break; } }
    const ch = SillyTavern.getContext().chat; const last = ch[ch.length - 1]; const g = last.extra?.manga || {}; const bs = g.scene?.beats || [];
    const SH = { 'extreme close-up': 'XCU', 'close-up': 'CU', 'medium shot': 'MS', 'full shot': 'FS', 'wide shot': 'WS' };
    rec.status = g.status; rec.error = g.error; rec.beats = bs.length;
    rec.cams = bs.map(b => (SH[b.camera?.shot] || '?') + ':' + (b.camera?.angle || '?') + (b.kind && b.kind !== 'character' ? '(' + b.kind[0] + ')' : '')).join(' ');
    rec.eye = bs.filter(b => (b.people || []).some(p => /viewer/i.test(p.gaze || ''))).length;
    rec.distinctViews = new Set(bs.map(b => (b.view || '').toLowerCase()).filter(Boolean)).size;
    rec.quality = (g.panels || []).map(p => p.quality ? (p.quality.pass ? 'P' : 'F') + p.quality.attempts : '-').join(',');   // P1 = passed first look, F2 = failed after a redraw
    rec.failReasons = (g.panels || []).flatMap(p => (p.quality?.reasons || []).map(r => String(r).slice(0, 70)));
    rec.msgIndex = ch.length - 1; rec.elapsed = Math.round((Date.now() - rec.t0) / 1000); rec.state = 'done';
  } catch (e) { rec.state = 'error'; rec.err = String(e); } })();
  return rec;
};

// items = [[label, playerText], ...]; stops after 3 errors in a row or when window.__stopQueue = true
window.__mmQueue = async (name, items) => { let errs = 0;
  for (const [l, t] of items) { const rec = window.__mmTurn(l, t, name); while (rec.state !== 'done' && rec.state !== 'error') await sleep(2000);
    if (rec.err && /WRONG CHARACTER/.test(rec.err)) { window.__abort = rec.err; return false; }
    errs = (rec.state === 'error' || rec.status === 'error') ? errs + 1 : 0;
    if (rec.state === 'done' && rec.status === 'done' && /[13579]$/.test(l)) window.__critique(rec.msgIndex).then(x => { window.__critiques[l] = x; }).catch(e => { window.__critiques[l] = { text: 'ERR ' + e.message }; });
    await sleep(3000); if (window.__stopQueue || errs >= 3) { window.__abort = errs >= 3 ? '3 errors in a row at ' + l : 'stopped'; return false; } }
  return true; };

// Switch character AND verify (selectCharacterById alone failed silently once and sent 6 turns into the wrong chat):
window.__switchTo = async (name) => { const c = SillyTavern.getContext(); await c.selectCharacterById(c.characters.findIndex(x => x.name === name));
  for (let i = 0; i < 25; i++) { await sleep(1000); const k = SillyTavern.getContext(); if (k.characters[k.characterId]?.name === name && k.chat.length > 0) return true; } return false; };

// Example: await __switchTo('Example Card') && __mmQueue('Example Card', [['monster-01', "I step into the lane with my hands visible."]]);
// Poll:    JSON.stringify(__turns.map(r => r.label + ':' + r.state + ' ' + (r.cams||'') + ' ' + (r.quality||'')))

// Consistency audit of ONE finished reply (message index in the open chat): does each person/place look the same in every frame?
// Uses the cast book stored with the message (names, looks, outfits). Costs about $0.006. Returns plain text to put in the report.
window.__consistency = async (msgIndex, model = 'google/gemini-3.8-flash') => {
  const c = SillyTavern.getContext(); const vc = await import('/scripts/extensions/third-party/SillyTavern-MangaMode/vision-check.js');
  const m = c.chat[msgIndex]; const g = m.extra.manga; const cast = (g.cast || []).filter(p => p.role !== 'player').map(p => `- ${p.name}: ${p.look || ''}; outfit: ${p.outfit || ''}`).join('\n');
  const content = [{ type: 'text', text: `You check VISUAL CONSISTENCY of ${g.panels.length} consecutive webtoon frames of one scene. Expected recurring people (from the story's cast book):\n${cast || '(none besides the viewer)'}\n\nFor each frame number, list ONLY real problems, each tagged MINOR or MAJOR: (a) a person's face/hair/skin/body/age differs from the description or from the other frames, (b) outfit or carried items change without the story saying so, (c) the same place changes layout/colour/lighting between frames, (d) an object changes shape/count/position impossibly, (e) extra or missing people, duplicated limbs, wrong hands. Ignore art style. If a frame is fine write "OK". Finish with: TOTAL MAJOR n, TOTAL MINOR n. Max 220 words.` }];
  for (const p of g.panels) content.push({ type: 'image_url', image_url: { url: await vc.imageDataUrl(p.imageUrl, 640) } });
  const r = await c.ConnectionManagerRequestService.sendRequest(c.extensionSettings.mangaMode.connectionProfileId, [{ role: 'user', content }], 1500, { includePreset: false, includeInstruct: false, extractData: false }, { model, reasoning_effort: 'low' });
  return { text: r?.choices?.[0]?.message?.content, cost: r?.usage?.cost };
};

// After the user pastes a NEW OpenRouter key, SillyTavern makes a new secret id; the profile keeps the old one and every call fails with
// "API request failed". This re-points the Manga Parser profile at the currently active OpenRouter key and tests it (3 tiny calls, < $0.001).
window.__repairProfile = async () => {
  const c = SillyTavern.getContext(); const id = c.extensionSettings.mangaMode.connectionProfileId; const prof = c.extensionSettings.connectionManager.profiles.find(x => x.id === id);
  const sec = await (await fetch('/api/secrets/read', { method: 'POST', headers: c.getRequestHeaders(), body: '{}' })).json();
  const active = (sec.api_key_openrouter || []).find(k => k.active);
  if (!prof) return { error: 'profile not found' }; if (!active) return { error: 'no active OpenRouter key stored in SillyTavern' };
  const before = prof['secret-id']; prof['secret-id'] = active.id; c.saveSettingsDebounced(); await new Promise(r => setTimeout(r, 2500));
  const out = { changed: before !== active.id };
  try { const r = await c.ConnectionManagerRequestService.sendRequest(id, [{ role: 'user', content: 'Say OK' }], 200, { includePreset: false, includeInstruct: false, extractData: false }, {}); out.parserOk = /OK/i.test(r?.choices?.[0]?.message?.content || ''); } catch (e) { out.parserOk = false; out.err = String(e.cause?.message || e.message); }
  return out;
};
