# Moment cards and scene state

**Study notes, superseded in 1.1 by the Direct planner (`docs/DIRECT.md`).** Moment cards were an experimental planning mode (`pipeline: 'moment'`) that never shipped in a release.
The setting is gone; Direct is the only planner. The card code stays only so that a page planned with cards can still be redrawn, and its measurements are kept below as the record of how Direct came about.
The text below describes the experiment as it was.

## Why

The classic path asks the story reader for a picture description, and the description can drop the thing the passage is
about (who hands what to whom, which hand holds the phone, who is standing where). A moment card makes the reader first write
down what the picture *must show*, then describe the picture.

## The card (one per frame)

- `facts` - 2 to 4 short statements taken from the text (never invented).
- `needs` - what the frame must be able to show: `faces`, `hands`, `whole body`, `both people`, `the place`, `an object`.
- `holding` - `[{person, object, hand}]`.
- `spots` - `[{person, spot}]` where people are in the place.
- `invented` - details the reader chose that the story did not say. They are kept apart so they are never presented as facts.

## What the code does with it

- **Camera by clarity** (`momentCamera`): a close-up whose card needs hands, an object or both people becomes a medium shot;
  one that needs the whole body or the place becomes a full shot. A shot is only ever widened, never narrowed. Inserts and
  establishing shots, which were chosen on purpose, are left alone.
- **Prompt**: a sentence "The key moment, clearly visible: ..." from the facts (kept only if it adds at least three words the
  description lacks), "He holds a smartphone in his right hand.", "She is beside the refrigerator." (only when the spot adds at
  least two new words).
- **Text hygiene**: the place is said once instead of three times, and "someone's" is replaced ("the wrist", or "her wrist").
- **Scene state**: at the end of each reply the reader records `state` (`objects` and where they are, `spots`, `light`). The next
  reply's reader is shown it as a STATE block so a phone held in one reply is not forgotten in the next.

## What it does not do

- It does not change the classic path: `withoutMoments` strips cards before planning when the setting is classic.
- **Redraw cannot create cards.** Redraw reuses the saved storyboard and skips the reader. A storyboard saved before cards existed
  (`parserVersion` 4) has none, so Redraw falls back to classic planning and says so (`pipelineNote`). To get cards, use
  "Draw again" or a new reply.
- It does not guarantee the image model draws the facts. It makes sure the facts are in the prompt and the camera can show them.

## What was measured (one tester, one character, one story, hand-judged)

Setup: a 10-message test chat (sitting and standing, objects handed over, a changed outfit, several places including a vehicle interior), Anima Turbo through a user workflow with IP-Adapter, at most 10 pictures per reply.

- **Same reply texts, classic vs moment** (10 replies, 69 vs 71 pictures, one seed each): the pictures followed the text's events more closely in 5 replies
  (an object moved across a surface, held objects in the right hands, a door held open, a hand pressing a button), were about even in 4,
  and were worse in 1: the reader forgot to list a vehicle as a place and a one-word match pulled another room into it. That is fixed
  for the moment pipeline (`matchPlace` strict mode); the classic pipeline still matches the old way.
- **Same storyboards, classic vs moment planning** (3 replies redrawn, reader skipped): comparable pictures. Most of the gain comes from the reader's cards, a smaller part from the
  planner and the prompt.
- **Fresh chat, same 10 messages** (new replies, so not a controlled comparison): the pictures matched each reply's own events in most frames.
- **Cost**: the reader's output grew from about 2,500 to 3,600-4,000 tokens per reply ($0.0126 to $0.018-0.020 per reply on the tested reader model).
  Those prompts were still carrying the old Anima patches (about 305-310 words). Without patches they are about 266 words (see "Patch removal" below).
  All of the measurements above were made WITH the patches; they say nothing about the patch-free path.
- **Not tested**: other characters or stories, several seeds per scene beyond a few redraws, other image models, character reference pictures on/off.

Known weak spots: a frame that must show hands on a button can still draw hands on the wrong thing; a key fob can look like a phone; the reader sometimes
files a recurring object (a car) as an object instead of a place; a held-object list can repeat an object for two people.

## Patch removal (1.1: the new path has no patches)

From 1.1 the moment path contains none of the Anima workarounds (`docs/RULES.md` lists them: 16 switches, ten prompt sentences, six rewrites
and pipeline steps). Classic keeps them. What this changed, measured on the saved storyboards and cards of the same 10-reply test chat,
with no new chat messages and no reader call. Same cards, same text, same graph and settings, no reference pictures; the only difference
between the two arms is the patches. 11 varied frames and 2 two-person frames, 3 seeds each (7, 1234, 98765), 78 pictures, rated by hand
for **event** (the card's facts), **relations** (who holds / looks at whom, left-right order), **identity** (the same person, whose hands) and **beauty**.

- Prompts: 310.8 words with patches, 266.4 without (71 frames, -14%). Five close-up frames are drawn once instead of twice (no crop and no detail pass).
- 13 cases rated: event same in 9, slightly better in 2, worse in 2; relations same in 10, worse in 3; identity worse in 1; beauty same in 13.
- **Worse without patches**: (1) a hand close-up of a worn object: the hands came out as the viewer's own in 3 of 3 seeds (with the guard sentences they were the
  other person's, with her clothing in view in 3 of 3): this is the failure `insertGuards` was written for. (2) A hand-over of two held objects:
  they were held out in 3 of 3 seeds with patches, and sat on the counter in 2 of 3 without. (3) A synthetic two-person scene (she stands, he sits): left-right order
  was wrong in 1 of 3 seeds and eye contact weaker in 2 of 3 (with `sideAnchors` / `openSpace`: right order and eye contact in 3 of 3). (4) A synthetic hand-over of a cup between two people: completed in 2 of 3
  seeds without patches, 3 of 3 with. These were recorded and the patches were **not** put back.
- **No visible loss**: night scenes (mean brightness 88.6 vs 88.8, 101 vs 97, 63 vs 69 in three dark frames), posture, white backgrounds,
  lettering on signs, a wall between two people (none appeared in either arm), an outfit leaking onto the other person (none in either arm).
- **Not measured**: the close-up crop (a face close-up asked for directly came out as a waist-up picture in both arms; with patches the page would then crop to the head, which was not simulated);
  tall frames (none in the set); the reader's own Anima-era instructions (side variation, onlookers), because the test holds the reader's output fixed; any other image model.
- Everything is one tester, one story, 3 seeds per frame. Differences of one picture in three are inside seed noise; the hand close-up frame (3 of 3) is the clearest.

## Shorter prompt, tested separately

On the patch-free path only. The "short" prompt keeps the same cards, shots, settings and seeds, and drops the sentences that repeat the card
(the beat's description and contact sentence, "In this view ...", the era line) and keeps the first three items of the place's description:
190 words against 234 on the same 11 frames (-19%). 33 pictures against the same 33 patch-free pictures.

- It did **not** improve pictures. The hand that pushes a cup was missing in 3 of 3 seeds (the sentence about it lived only in the description). A frame where
  only the player's hands and a plate were stated drew the other person seated in 3 of 3. Two dark indoor frames got more exaggerated anatomy and one a white margin. The only gain: a cup carried through
  a doorway was held in 3 of 3 seeds instead of 1 of 3.
- Verdict: this way of shortening costs content; it is not adopted. Shortening needs to cut wording, not facts (a card-aware merge), and would have to be tested again.
