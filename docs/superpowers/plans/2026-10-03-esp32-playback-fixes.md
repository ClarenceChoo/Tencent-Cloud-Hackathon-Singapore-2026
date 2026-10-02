# ESP32 Playback Fixes Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox syntax for tracking.

**Goal:** Fix the four reviewed ESP32-S3 defects and open a tested PR against `main`.

**Architecture:** Keep the existing ESP-IDF audio and networking interfaces. Add host regressions that compile the actual application code with hardware/HTTP/NVS doubles. Persist command stages before accepting or starting playback, retain reply context independently of playback completion, and flush the legacy I2S DMA pipeline with bounded silence writes before shutdown.

**Tech Stack:** C11, ESP-IDF v5.4.2, legacy I2S, FreeRTOS, NVS, host C compiler and Python 3.

**Spec:** `firmware/README.md` and the four findings in this chat.

## Global Constraints

- ESP32-S3 only; preserve ESP-IDF `>=5.4.2,<5.5` and WebSocket client 1.4.0.
- Never replay interrupted or uncertain commands automatically.
- Keep peripheral GPIO defaults at `-1`; do not invent board wiring.
- Preserve existing HTTPS/WSS and backend confirmation contracts.
- Do not merge the PR; target `main` for review.

## Review Focus

- Failed NVS writes at receipt, start, and terminal stages must not create durable claims or permit automatic replay.
- A valid new reply context must survive a button interruption; expired and explicit null context must not revive an older proposal.
- Successful speaker output must transmit all PCM before shutdown; drain failure and interruption must not count as completed.
- Both I2S pin maps must leave unused MCLK unrouted.
- Reboot/redelivery must suppress a durably started command even when terminal persistence fails.

### Task 1: Regression harness and command persistence

**Files:** Create `firmware/test/` host harness; modify `firmware/main/device_network.c`, `firmware/main/include/careloop_app.h` if a fault latch is necessary.
**Interfaces:** `ledger_stage(...) -> esp_err_t`; existing playback and event entry points remain unchanged.

- [x] Compile real application translation units with test-only ESP-IDF doubles; run each case separately so every failing behavior is visible.
- [x] Verify receipt/start/terminal persistence tests fail on existing code.
- [x] Return NVS errors, restore the previous entry on failed saves, and suppress playback/start/completed acknowledgements when their prerequisite durable stage fails. Retain conservative suppression after uncertain playback.
- [x] Run all firmware host tests.

### Task 2: Reply context

**Files:** Modify `firmware/main/device_network.c`; extend `firmware/test/` regressions.
**Interfaces:** Existing `careloop_network_play_pending(careloop_app_t *)` and context helpers.

- [x] Verify interrupted new context, explicit null context, and expiry cases against existing code.
- [x] Apply valid reply context before playback under the state mutex, including explicit clearing; do not restore it after expiry or failure.
- [x] Run all firmware host tests.

### Task 3: I2S routing and completion

**Files:** Modify `firmware/main/board_audio.c`; extend `firmware/test/` regressions.
**Interfaces:** Existing `careloop_board_init(...)` and `careloop_play_wav_stream(...)`.

- [x] Verify unintended MCLK routing and lost queued PCM regressions fail.
- [x] Set `.mck_io_num = I2S_PIN_NO_CHANGE` for both pin configurations.
- [x] Use shared DMA dimensions and append more than one complete DMA ring of silence in bounded writes, checking interruption and write errors, before normal shutdown. Abort paths still stop immediately.
- [x] Run all firmware host tests, including drain timeout/interruption and partial-write cases.

### Task 4: N16R8 hardware compatibility (user scope update)

**Files:** Modify `firmware/sdkconfig.defaults`, `firmware/main/board_audio.c`, and hardware regressions.
**Interfaces:** Existing board initialization; default ESP-IDF memory configuration.

- [x] Verify reserved GPIO35/36/37, invalid GPIO23, and duplicate assignments fail on existing code.
- [x] Default to 16 MB Quad flash, 8 MB Octal PSRAM, boot initialization, 80 MHz memory clocks and capability allocation.
- [x] Reject unavailable/internal, non-output and duplicate peripheral pins before GPIO configuration; reserve GPIO19/20 when USB Serial/JTAG console is enabled.
- [x] Validate generated `sdkconfig` and image fit in the real ESP-IDF build.
- [x] Document that the 44-pin carrier and Type-C connector alone do not identify peripheral wiring or the console route.

### Task 5: Validation and PR

**Files:** Update `firmware/README.md` test commands and behavior notes; include this plan.

- [x] Review the entire diff and run the complete firmware host suite with warnings as errors and sanitizers where supported.
- [x] Attempt a fresh ESP-IDF v5.4.2 source-check build if tools can be obtained; report hardware validation separately.
- [x] Obtain a fresh independent whole-branch review and resolve important findings.
- [ ] Commit only this task's files, push `codex/esp32-playback-fixes`, create and attach a PR targeting `main`.

## Execution record

- Initial application regressions: 11 expected failures across the four reviewed defects; five additional expected failures for N16R8 pin compatibility. Each passed after its corresponding implementation.
- Independent whole-change review identified NVS persist-before-error semantics. The added `uncertain_failure` test failed before the fix and passed afterward. Every post-start failed-audio replacement now uses durable UNKNOWN, so either the old PLAYING value or the new UNKNOWN value suppresses redelivery after reboot.
- Final host validation: both portable core executables and 27 application cases passed; the 27 cases also passed under AddressSanitizer and UndefinedBehaviorSanitizer.
- ESP-IDF v5.4.2 `idf.py build size` passed with N16R8 defaults. The final image is `0x19daa0` bytes in the existing `0x1a0000` app partition, leaving `0x2560` bytes (9,568 bytes, approximately 1%). No physical flashing or bench validation was performed.
- Scope update: the user's N16R8 hardware description determined the memory configuration. Peripheral GPIO defaults remain disabled because a module name, 44-pin count and Type-C connector do not establish the carrier's signal routing.
