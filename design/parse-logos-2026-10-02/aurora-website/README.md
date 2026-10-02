# Parse · Light Aurora Pearl website

The selected direction is **01 — Aurora Pearl**, using the approved Care Conversation emblem: two facing human profiles with a speech-shaped opening. Following the user's light-theme preference, the website carries its aqua, lilac, and champagne finish into warm ivory backgrounds, soft light, pearl controls, and navy text. The landing page, dashboard, sign-in, companion, and shared summary all use light surfaces.

## Palette and typography

| Colour | Hex | Role |
| --- | --- | --- |
| Warm ivory | `#FBF8F2` | Main page and header backgrounds |
| Pearl | `#F9FAF7` | Supporting sections and record surfaces |
| Navy | `#1B2944` | Readable headings and logo wordmark |
| Teal | `#176B78` | Links, focus indicators, and accents |
| Aqua | `#9CDDDC` | Highlights and controls |
| Lilac | `#CBBFE8` | Pearl reflections and gradients |
| Champagne | `#F7E8C8` | Pearl highlights |

DM Serif Display and DM Sans are served locally with their font licences. Gradients, local highlights, and soft shadows preserve the dimensional finish while care details remain readable on pale pearl backgrounds.

## Saved artwork

- Approved reference: [01-aurora-pearl.png](../care-conversation-themes/01-aurora-pearl.png).
- Transparent light-background logo: [parse-aurora-logo-light.png](../../../frontend/public/brand/parse-aurora-logo-light.png), 2135 × 736, with the original pearl profiles and navy lettering.
- Transparent emblem and favicon: [parse-aurora-mark.png](../../../frontend/public/brand/parse-aurora-mark.png), 1254 × 1254.
- The landing hero uses the transparent emblem on a light aqua/lilac mesh background; it has no dark image plate.
- Asset preparation used the built-in `image_gen` editing tool. The exact light-logo prompt is preserved in [light/logo-asset-prompt.json](light/logo-asset-prompt.json); the original transparent asset prompts remain in [logo-asset-prompts.json](logo-asset-prompts.json).

The common `BrandLogo` component supplies branding for the landing page, dashboard, sign-in, browser companion, fictional companion preview, and shared summary. Both HTML entries use the same favicon and warm ivory browser theme colour. Earlier explorations are retained locally. The current illustrative family images are generated fictional subjects; font sources and licences are recorded in [at-home-font-provenance.md](../../parse-landing-assets/at-home-font-provenance.md) and [font-provenance.md](../../parse-landing-assets/font-provenance.md).

## Local previews

- Landing: <http://127.0.0.1:5174/landing/>
- Login-free fictional dashboard: <http://127.0.0.1:5174/>
- Fictional companion introduction: <http://127.0.0.1:5174/companion>
- Authenticated mode and real companion entry: <http://127.0.0.1:5173/>

The two dashboard modes keep their existing behavior. The login-free preview uses fictional in-memory sample data and makes no backend calls. Paired companion and public summary screenshots were rendered using intercepted fictional reads in a temporary browser; they do not represent a real pairing or shared record. This update changes the local website source and preview.

The landing page header now has **Open Parse**, linking to the existing app on the same website. The dashboard footer has **About Parse**; the sign-in and companion logos return to `/landing/`. The desktop and mobile menus use the same destinations. The authenticated local site connects to its existing backend on port 8001.

## Verification · 2 October 2026

- Production build passed for both app and landing entries.
- Existing functional suite passed: 41 tests across 12 files.
- Current light landing review checked desktop, tablet, and phone widths from 320 to 1440 pixels, including the stacked emblem layout and full-width phone/tablet photo bands.
- Landing example checked review, editing, private confirmation, chosen-recipient sharing, blank-note prevention, cancellation, FAQ, and mobile navigation. It made no API calls and used no browser storage.
- All seven dashboard views, sign-in, companion preview, unpaired companion, paired companion review, and read-only summary rendered without page errors or horizontal overflow in the checked layouts.
- The paired companion keeps confirmation disabled while wording is being edited. The shared summary has no editable record controls. No microphone or backend write was used for visual checks.
- The light logo and emblem have alpha transparency, including transparent corners. Current rendered screenshots show the selected pearl colours, navy lettering, and light website treatment.
- Connected navigation passed at widths 1440, 1024, 768, 390, and 320 pixels for the landing and dashboard. Sign-in and both companion modes passed at 1440, 390, and 320 pixels. Links remained on the same origin, the public preview made no API requests, and checks made no backend writes. Results and screenshots are in [light/connected-navigation/checks.json](light/connected-navigation/checks.json).

Current structured results: [light/browser-checks.json](light/browser-checks.json), [light/surface-checks.json](light/surface-checks.json), and [light/landing-refinement-checks.json](light/landing-refinement-checks.json). Current desktop and mobile screenshots are saved under `light/`; the main website preview is [light/landing-hero-desktop.png](light/landing-hero-desktop.png).
