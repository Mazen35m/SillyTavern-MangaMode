# Manga Mode - turns your SillyTavern roleplay into manhwa pages

**Manga Mode** is an extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern), the chat app for AI roleplay.
You chat as usual. After every character reply, Manga Mode turns that reply into a colored manhwa / webtoon page:
the pictures are drawn on your own PC, and the dialogue appears as speech balloons on top of them.

**Status: 1.0.1 beta** - early public release. It works and has been tested live, but it is a beta (see "Honest limits" below).
License: MIT (free to use, change and share).

## What you get

- A page (or a long webtoon-style scroll) for every reply, with speech balloons and inner-thought balloons.
- **First-person view**: you are never drawn, you see the story through your character's eyes.
- **Consistent look**: the extension writes a "world book" for each chat (how people dress, what places look like) and keeps a cast book,
  so characters keep their face, hair and clothes from frame to frame.
- **Quality check**: a vision model looks at every picture and redraws the ones that are clearly wrong (extra limbs, missing person, lettering).
- You choose how many pictures each reply gets and how many redraws are allowed - there are no fixed presets.
- Works with the image model you like (SDXL / Illustrious / NoobAI, Pony, Flux, Qwen-Image, Z-Image, Anima), with the built-in workflow
  or with your own ComfyUI workflow.

## How it works

1. A **story reader** (an LLM you pick in SillyTavern, e.g. Gemini through OpenRouter) reads the finished reply and plans the frames like a manhwa artist:
   who is where, the camera angle, the light, who says what. It never writes new story.
2. **ComfyUI** (free, runs on your PC) draws every frame.
3. The **quality check** (a vision model) looks at each picture and asks for a redraw when something is clearly wrong.
4. The pictures are laid out as a page and the balloons are drawn on them.

## What it costs

ComfyUI is free and local. The story reader and the quality check use an LLM through OpenRouter (or another connection you choose):
measured on three test chats, about **$0.04-0.06 per reply** with google/gemini-3.8-flash. Frames per reply and redraws are your setting, so you control the time and the cost.

## Honest limits

The pictures come from a small local image model (tested with Anima Turbo on an RTX 3070, 8 GB). It draws mostly static poses, cannot show violent
first-person impact, repeats compositions, and the layout of a room or a recurring character's outfit can still change between frames.
An outside editor (Gemini) scored test replies 3-4 of 10 on average. Everything that was measured, including what failed, is in `docs/HOW-IT-WORKS.md`.
Strong graphics cards can switch on slower extras (detail pass, character reference pictures, matching faces) under "For strong GPUs".

## The settings, in short

The panel is Extensions -> Manga Mode. The top part holds what most people need: Enable, auto-draw, frames per reply, quality check and redraws,
webtoon mode, first-person view, balloons, the story-reader profile, the image-model prompt style, the ComfyUI address and the workflow.
"Advanced settings" holds the rest (reader thinking, check model, world book, prompt text, picture size, model profile and built-in workflow files).
"For strong GPUs" holds the slower extras.

## What it needs

**Required (this is the whole default setup):**

| Part | What | Where it goes |
|---|---|---|
| SillyTavern | 1.19 or newer | anywhere |
| ComfyUI | any recent (tested: ComfyUI-Easy-Install, ComfyUI 0.33) | anywhere, must run on http://127.0.0.1:8188 |
| Image model | `anima-turbo-v1.1.safetensors` + `qwen_3_06b_base.safetensors` + `qwen_image_vae.safetensors` | ComfyUI/models/diffusion_models, text_encoders (or clip), vae - links in DOWNLOADS.md |
| OpenRouter account | for the story reader and the quality check (both google/gemini-3.8-flash) - about $0.04-0.06 per reply | key goes into SillyTavern |
| Graphics card | tested on an RTX 3070 (8 GB) | |

The defaults of Manga Mode already point at these three Anima Turbo files, so with them in place it draws with the **built-in workflow** - nothing else to build or save in ComfyUI.

**Optional:**

| Part | What it gives you |
|---|---|
| ComfyUI-MangaMode-Bridge (the `comfyui-bridge` folder) | lets you pick your own ComfyUI workflow in the panel |
| ComfyUI-Easy-Use | the "detail pass" (For strong GPUs) |
| ComfyUI-Anima_IP-Adapter + `ip_adapter-Character_Reference-10.safetensors` | character reference pictures (For strong GPUs) |
| Another image model | pick its prompt style in the panel and fill in its files under Advanced settings (a saved "Illustrious-XL" profile is included as an example) |

## Install from zero (in this order)

1. **Get this repository**: GitHub Desktop -> File -> Clone
   repository -> Mazen35m/SillyTavern-MangaMode, or the green Code button -> Download ZIP.
   Put the folder here (the folder name must be exactly `SillyTavern-MangaMode`):
   `SillyTavern/public/scripts/extensions/third-party/SillyTavern-MangaMode`
2. **Image model**: download the three Anima Turbo files listed in `DOWNLOADS.md` into the ComfyUI folders shown there. Start (or restart) ComfyUI.
3. **SillyTavern connection**: API Connections -> Chat Completion -> OpenRouter, paste your
   OpenRouter key, model google/gemini-3.8-flash, then Connection Profiles -> save it as
   **Manga Parser** (the profile settings are in `recommended-settings.json` -> `mangaParserConnectionProfile`).
4. Start SillyTavern, open Extensions -> Manga Mode and check: Enabled, scene parser profile = Manga Parser, Workflow = "Built-in workflow", Quality check ticked.
5. Chat. Each character reply gets a page; the image button on a message draws or redraws it.

**Want to use your own ComfyUI workflow (optional)?** Copy the folder `comfyui-bridge` to `ComfyUI/custom_nodes/` and rename it
`ComfyUI-MangaMode-Bridge`. Open its `mangamode_bridge.json` and write your SillyTavern folder (the one with Start.bat), e.g.
`{"sillytavern": "C:\\path\\to\\SillyTavern"}`. Restart ComfyUI, then save your workflow in ComfyUI (Ctrl+S): it shows up in the Workflow list in Manga Mode
(if you have only one saved, it is picked for you; choose "Built-in workflow" to go back). Examples to start from are in `workflows/comfyui-ui/`.

## Recommended settings (optional)

The defaults already use Anima Turbo. `recommended-settings.json` holds the author's full setup (no API keys in it), which also switches on the slower extras for strong GPUs. To use it instead of the defaults:

1. Close SillyTavern.
2. Open `SillyTavern/data/default-user/settings.json` in a text editor.
3. Find `"extension_settings"` -> `"mangaMode": { ... }` and replace that whole `{ ... }` block with
   the `"mangaMode"` block from `recommended-settings.json` (if there is no `"mangaMode"` yet, start
   SillyTavern once with the extension installed, close it, then do this).
4. Start SillyTavern. In Manga Mode, choose your own story-reader profile in the drop-down and tick "Enable Manga Mode".

## Where things are

- `index.js` - the pipeline (story -> frames -> pictures -> page); `scene-parser.js` - the
  storyboard director; `prompt-builder.js` - frame prompts; `vision-check.js` - quality check;
  `world-book.js`, `cast-book.js`, `set-book.js` - consistency; `custom-workflow.js` - ComfyUI
  workflows; `character-refs.js` - reference pictures for the IP-Adapter.
- `docs/HOW-IT-WORKS.md` - the pipeline, the files and what was measured; `docs/RUNNING.md` - running and re-testing;
  `DOWNLOADS.md` - every model and node with its link.
- Tests: `node tests/<name>.test.mjs` (10 suites in `tests/`, all must print passed).

## Versions

Releases are listed on the GitHub Releases page. Any release can be downloaded as a ZIP from there.
The folder name must be exactly `SillyTavern-MangaMode`.
