# Hyperframes Composition Brief: Parse

Create a 22-second, 1920x1080 landscape launch film in composition/, rendering to ../brag.mp4.

Source: repository at main d376d64; frontend/src/Landing.tsx, landingCopy.ts, landing.css, Companion.tsx, companion.css, App.tsx, RecordingReceipt.tsx and turnReceipt.ts. Use project assets at frontend/public/landing/at-home-family.webp, at-home-window.webp, and frontend/public/brand/parse-aurora-logo-light.png. Use the bundled DM Serif Display and DM Sans WOFF2 fonts.

Creative contract: brag-plan.md. Polished, warm at-home product film. Hook: “Care, in your own words.” Then demonstrate tap → review → confirm → permitted caregiver timeline. End: “Your words. Your choice.” Show software behavior, preserve confirmation and permissions. Fictional example; interactions/speech simulated. No hardware, clinical effectiveness, automatic emergency detection or unverified claims.

Copy from source: “A moment to speak”, “Talk to Parse”, “Tap to record”, “Please check this first”, “Confirm and save”, “Hear read-back”, “Confirmed and saved.” UI details recreated at video-readable scale. Fictional note: “My knee felt stiff after our walk today.”

Palette: app #fbf8f2, #1b2944, #176b78, #9cdddc, #cbbfe8; landing ivory #fbf8f4, ink #30211c, terracotta #a34f31. Serif speaks for the person; sans makes UI and provenance precise.

Audio: bundled vol-12 music at 0.28 gain, fade 0.6s in / 1.3s out. Cue JSON copied locally. Read-back near 8.74s; outro near 18.56s. Three sparse low-risk SFX; select after motion timing. SFX analysis read from brag skill assets/sfx/sfx-analysis.md. No narration. No visualizer.

Implementation: native Hyperframes root composition, local media and runtime, synchronous seek-safe timeline; readable holds; gentle transitions between every scene. Follow installed core, animation, creative, keyframe and CLI skills. Check with zero errors before render. Pick a settled, strong poster, extract brag.jpg, and bake it into frame zero without changing timing or audio. Also deliver share-copy.txt.
