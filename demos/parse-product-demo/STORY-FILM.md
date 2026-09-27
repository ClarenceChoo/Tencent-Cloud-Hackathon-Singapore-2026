# Parse — From her voice to her care circle

102-second, 1920×1080, 30 fps concept film. Captions and dialogue text only, with no narration or audio track.

## Story

Mei wears Parse as a 3D-printed transit-card holder. She presses its button and reports knee discomfort after a walk, asking to share it with Jamie. The film illustrates the proposed pendant → phone → Parse → care-circle connection. A read-back checks the note and sharing choice. Mei confirms. The actual app records the simulated device message and updates both her phone view and Jamie’s caregiver dashboard without a reload. Jamie acknowledges a separate request for a call and records the agreed outcome. Medication reminders, the checked plan, and a reviewed visit summary complete the story.

## What is real and what is simulated

- People and pendant are fictional AI-generated photographic stills, animated with camera moves and typography in Remotion. They are not live-action or lip-synced footage.
- The hardware connection and speech interpretation are deliberately simulated. The phone relay is a proposed interaction, not a completed Bluetooth integration.
- The browser recordings are real Parse software. The isolated fixture sends authenticated WAV requests through the existing device API, receives a confirmation proposal, sends an explicit confirmation, and verifies that the record is committed. Both web views update through the app’s existing automatic refresh.
- Caregiver acknowledgement, outcome recording, visit-summary review and read-only sharing are performed in the real interface.
- No production records, real patients, cloud speech credentials, or main application code are used or changed.

## Render

The published movie is [exports/parse-companion-story.mp4](exports/parse-companion-story.mp4?raw=true). To render a new copy, run `npm ci`, then `npm run render:story`. New output goes to `out/parse-companion-story.mp4`.

The source includes the captured clips and generated images, so rendering does not require the Parse server. Browser recordings can be recreated with the scripts described in [README.md](README.md); they use this repository by default and accept `PARSE_REPO_DIR` for another checkout. The separate database and raw takes are excluded from the source package.

## Assets and generation

Built-in image generation was used for `public/story/mei-pendant.png`, `pendant-detail.png`, and `caregiver.png`. The retained prompt briefs are in `STORY-IMAGE-PROMPTS.md`. Only generated imagery was used as a reference. No real person’s photo was supplied.
