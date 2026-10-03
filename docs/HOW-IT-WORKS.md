# How Manga Mode works, and what was measured

## The pipeline for one reply

1. **Story reader** (`scene-parser.js`). An LLM reached through a SillyTavern Connection Profile reads the finished reply
   and returns a storyboard as JSON: the cast, the places, and a list of "beats" (one per picture) with the camera
   (shot and angle), the light, who is where, what they do, and which dialogue lines belong to the frame. It never writes
   new story. Code then completes and corrects the storyboard (first-person mode, shot variety, composition, balloons).
2. **World book, cast book, set book** (`world-book.js`, `cast-book.js`, `set-book.js`). Written once per chat from the character card,
   persona and lorebook, and extended as the story goes: how people dress, what places look like, and a fixed look for every named person.
   Every frame prompt is built from them, so the same person is described the same way each time.
3. **Prompt builder** (`prompt-builder.js`). Turns one beat into a prompt for the image model, in the style you chose
   (tag list, tag list with Pony score prefix, or sentences). Names are replaced by visual labels, so the image model never sees them.
4. **Drawing** (`image-generator.js`, `custom-workflow.js`). ComfyUI draws the frame with the built-in workflow or with a workflow you saved
   in ComfyUI (the bridge add-on copies it into SillyTavern). Close-ups can be cut from a larger picture and redrawn sharper (detail pass).
5. **Quality check** (`vision-check.js`). A vision model compares each finished picture with its frame (every main figure present once,
   matching look and outfit, no lettering, no extra limbs). A failed check is confirmed by a second look before a redraw,
   a redraw uses a new seed, and the best attempt is kept.
6. **Page** (`page-layout.js`, `renderer.js`, `bubbles.js`). The pictures are laid out as a page, or as one webtoon scroll, and speech
   and thought balloons are placed on them without covering faces.

## Files

- `index.js` - the pipeline and the settings panel; `settings.js` / `settings.html` - defaults and panel; `job-key.js` - decides when a saved page is still valid.
- `director.js`, `frame-plan.js` - panel planning; `panel-crop.js`, `image-analysis.js` - crops and head finding.
- `model-profiles.js` - saved setups per image model; `custom-workflow.js` and `comfyui-bridge/` - your own ComfyUI workflows.
- `character-refs.js` - reference pictures for character consistency (optional, For strong GPUs).
- `tests/` - ten suites that need only Node: `node tests/unit.test.mjs` and so on. `tools/` - helpers for live studies (run in the browser console).

## What was measured

Everything below was measured on three test chats (different character cards), with Webtoon and first-person mode on, using
Anima Turbo on an RTX 3070 (8 GB) and google/gemini-3.8-flash as story reader and checker.

- **Stability**: 30 live replies, 0 errors.
- **Cost**: about $0.04-0.06 per reply on OpenRouter (story reader about $0.013, the rest is picture checks). ComfyUI is local and free.
- **Checker**: on 35 hand-labelled pictures (24 good, 11 with a real fault), the first checker redrew 46-67% of the good pictures for taste.
  A more tolerant instruction and a better model brought that to about 25% (21% with two looks), with 1 of 11 real faults missed.
  The share of frames the checker still flagged after redraws fell from 29%, 57% and 50% on the three chats to 10%, 35% and 33%.
- **Light**: scenes at night, in blackouts, cellars or storms now come out dark instead of evenly bright.
- **Composition**: a single person no longer sits in the centre frame after frame; the figure moves to the left or right third.
- **Image quality**: an outside editor (Gemini) scored test replies 3.1-4.4 out of 10 on average. The target of 7 was not reached.

## Known limits

The pictures come from a small local image model. It draws mostly static poses, cannot show violent first-person impact, repeats
compositions, and the layout of a room or the outfit of a recurring character can still change between frames. Character reference
pictures (IP-Adapter) were inconclusive in tests, so they are off by default. A better image model, or the "For strong GPUs" extras on a
bigger card, is the most likely way to improve this.
