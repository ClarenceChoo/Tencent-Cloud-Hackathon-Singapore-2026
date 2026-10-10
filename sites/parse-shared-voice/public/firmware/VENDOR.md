# Browser installer dependencies

The unmodified `esptool-0.6.1.js` is `bundle.js` from the official `esptool-js@0.6.1` npm package published by Espressif. Source: https://github.com/espressif/esptool-js .

SHA-256: `ef7d5a237d3f273ecf546bcee65dddad90bd82cf02f22a980d1537e0cd79a152`.

The Apache-2.0 license is included. The bundle also contains pako 2.1.0 (MIT and Zlib), atob-lite 2.0.0 (MIT), and TypeScript helpers (0BSD). Their license and copyright notices are included beside this file. This file documents third-party software; it is not a firmware verification result.

The installer serves these assets from the Parse site. It does not load executable code from a third-party CDN. Flash backups remain local to the browser and are never uploaded.
