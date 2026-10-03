# Prompt Styles and model profiles

> **From 1.1 the planner (Direct) writes sentence prompts for every style.** `natural` is what it is made for. The `tags` and `tags_pony` rows below describe the 1.0.x prompts
> (still used to redraw older pages); for a tag-only model (Illustrious, NoobAI, Pony) the 1.0.1 release serves better. See `DIRECT.md`.

## Prompt Style (text format only)

| Style | Parser field used | Wrap | Per-panel output (consistency on) |
|---|---|---|---|
| `tags` - Illustrious/SDXL | `image_tags` + per-person `visual_tags` | prefix, tags, suffix joined with commas | shared chunk + one chunk per person, joined with ConditioningConcat; canonical traits, people count, camera tags, adult/clothed guards added by code |
| `tags_pony` - Pony | same as `tags` | Pony preset (score prefix) on the shared chunk only | same as `tags` |
| `natural` - Flux/Qwen-Image/Z-Image/Anima | `shared_description` / beat `description` + per-person `description` | prefix, paragraph, suffix joined with spaces | ONE paragraph: exact people count, camera sentence, shared description, then one sentence per person that names them with canonical traits, outfit, adult/clothed guards |

Stored in `extensionSettings.mangaMode.promptStyle` and `.promptPresets[style]`; both are part of the per-message cache hash. Each generated panel records `promptStyle` and `modelProfile`, shown in the debug block. With consistency off every style falls back to the original single-field prompt.

The 1.0.x parser returned both forms (tags and sentences); Direct returns one frame description and the style only changes the prefix, suffix and wording around it.

## Model profiles (model-profiles.js)

A profile bundles: workflow family (`checkpoint` = one file, `split` = diffusion model + text encoder + VAE), the model files, sampler/scheduler/steps/CFG/size, model-specific negative terms, and which Prompt Style to use. Applying one copies it into the live settings; the server URL and your own negative prompt stay global.

## Style per model (filled in as models are tested)

| Model | Profile | Workflow | Prompt Style | Prefix / suffix | Why |
|---|---|---|---|---|---|
| illustriousXL_v01 | Illustrious-XL v0.1 (tags) | checkpoint, workflows/001 | `tags` | preset defaults | Danbooru-tag model with a CLIP text encoder |
| oneObsession_v24 | One Obsession v24 (tags) | checkpoint, workflows/001 | `tags` | suffix: masterpiece, best quality, amazing quality, very awa, absurdres, newest, very aesthetic, highres, colored manhwa style, webtoon illustration; model negative: worst quality, normal quality, anatomical nonsense, bad anatomy, interlocked fingers, extra fingers, simple background, transparent; CFG 5 | Illustrious fine-tune, CLIP text encoder; creator's recommended quality tags |
| anima-turbo-v1.1 (default) | Anima Turbo v1.1 (natural) | split files, workflows/003 | `natural` | prefix: masterpiece, best quality, score_7, safe. A colored webtoon manhwa illustration. / suffix: Clean digital lineart, cel shading, vibrant full color.; model negative score_1-3 (inactive at CFG 1); er_sde/simple, 10 steps, CFG 1 | Qwen3 language-model text encoder; CircleStone recommends naming each character and describing them in sentences for multi-character scenes, with quality + 'safe' tags first. Benchmarked natural (22-25/27) vs flattened tags (18/27) |
