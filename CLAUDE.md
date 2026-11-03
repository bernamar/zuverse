# Zuverse

This repo is Zuverse: a CLI that reverse-engineers a video ad (TikTok, Instagram, Facebook Ad Library, or a file)
and remakes it shot for shot with a new person, voice and brand, on Zurelay (Gemini 3.1 Pro, GPT Image 2.5,
Seedance 2.5).

When the user wants to copy, remake or analyze an ad, follow the `zuverse` skill
(`.claude/skills/zuverse/SKILL.md`). In this repo the CLI is `node bin/zuverse.mjs`.

First run in a fresh clone:

1. `npm install` (downloads ffmpeg too)
2. `node bin/zuverse.mjs doctor`
3. Keys live in `.env` (gitignored). If `GEMINI_API_KEY` and `KIE_API_KEY` are both set, Zuverse uses those
   (Gemini for reading and text, Kie for images and video). Otherwise ask for a Zurelay key
   (https://zurelay.com, API keys) and have them put `ZURELAY_API_KEY=zr_live_...` in `.env`.
   Never print, echo or commit a key.

Rendering costs the user money: show `node bin/zuverse.mjs cost <project>` and get a yes before any command with
`--yes`.

## Working on the code

- Node 18+, ESM, no build step, no runtime dependencies (ffmpeg-static/ffprobe-static are optional).
- `npm test` runs the unit tests (`node --test`).
- `src/prompt.mjs`, `src/run.mjs`, `src/shot-plan.mjs` and `src/direction.mjs` are ports of the Zuops Video Ad
  Copier's pure modules; keep their behaviour in step with the tests.
- Projects (`zuverse-projects/`) and `.env` are gitignored; never commit either.
