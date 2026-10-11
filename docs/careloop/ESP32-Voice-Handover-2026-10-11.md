# ESP32 voice handover — 11 October 2026

**Status: hardware testing paused at the user's request.** The idle laptop relay was stopped. No more recording, playback, flashing or wiring checks are scheduled. Bluetooth firmware is restored on the ESP32 and stays silent until an explicit request. The local diagnostics page is offline while the relay is stopped.

This note adds the latest software and audio results to the [hardware handover](Hardware-Handover-2026-10-09.md), whose 10 October assembly results remain valid historical observations. The current route is **INMP441 → ESP32 → Bluetooth → laptop relay → shared Parse dashboard**, with spoken replies available on the laptop. Onboard speech playback is implemented but acoustically unresolved.

## Saved wiring and firmware

| Connection | Handover configuration |
| --- | --- |
| INMP441 microphone | SCK GPIO4, WS GPIO5, SD GPIO6, L/R GND; 3V3 and common ground |
| MAX98357A digital audio | BCLK GPIO7, LRC/WS GPIO15, DIN GPIO16 |
| Amplifier power and enable | VIN 3V3 rail, GND common with ESP32, SD/EN 3V3; firmware enable GPIO `-1` |
| Speaker | Nominal 8 ohm, approximately 1 W, connected across the two amplifier output terminals |
| Button | Handover uses GPIO18 to GND; not retested this session. The earlier GPIO8 jumper proposal remains untested. |

The user confirmed that the amplifier connects to the breadboard's power and ground rails. The exact rail-to-ESP32 ground connection and continuity were not rechecked in this session. Neither speaker terminal should connect to ground.

The restored image uses the [microphone diagnostic](../../firmware/diagnostics/microphone/README.md) with `sdkconfig.bluetooth` and `sdkconfig.speaker-handover`. It receives microphone audio on I²S0 and sends speaker audio on I²S1 at 16 kHz with 32-bit stereo slots. The installed application is 570,032 bytes, SHA-256 `dd025cf026926c82d14b9f33cb425e935277f68c78f8baee541d444e642341ab`.

Runtime binaries, private flash backups, recordings, credentials and pairing/session data remain local and are not included in this handover. Rebuildable source and configuration overlays are committed.

## What was heard

| Test | Digital result | User's listening result |
| --- | --- | --- |
| Three pairs of short tones, handover wiring, amplitude 3000/32767 | All writes completed; no brownout reported | Notes audible |
| Speech over Bluetooth, original level, 16-bit output slots | Encrypted transfer, SHA-256 and driver completion passed | Buzzing / heavily distorted |
| Same speech at one-quarter amplitude, 16-bit slots | Transfer and driver completion passed | Still distorted |
| Quiet speech with 32-bit output slots | Transfer and driver completion passed | Still distorted |
| Identical quiet speech embedded in a temporary offline image, Bluetooth disabled and no Wi-Fi initialization | Driver completed in 6,509 ms including 160 ms padding; no brownout reported | Still distorted |
| Original source speech played on the laptop | Local reference playback | Clear speech |

The speech clip was a 6.35-second, 16 kHz mono PCM16 WAV: “Hello Anson. This is Parse speaking. The text to speech test is working.” The 203,244-byte Bluetooth return transfer plus playback took approximately 69 seconds. That latency also needs improvement before onboard replies can feel prompt.

These comparisons show that the source speech is intelligible and the distortion also occurs without active Bluetooth. They do not identify the remaining fault in the ESP32, I²S wiring, amplifier, power/ground or speaker path. Driver success alone does not establish clear audio. The 10 October understandable-but-muffled offline prompt and today's distorted TTS are separate observations with different test builds and clips.

## Code saved with this session

- Optional Bluetooth speaker output verifies the declared WAV format, complete SHA-256 and contiguous chunks before queueing playback. Capability and playback status distinguish delivery from driver completion. Capture is blocked while a reply is being received or played, and expired sessions stop playback.
- Speaker PCM is mapped into both 32-bit slots. Whole-clip peak limiting reduces amplitudes above 8000/32767 without increasing quiet clips. Partial writes, driver errors and session expiry fail the request instead of reporting success.
- The laptop relay can opt into onboard replies with `--speaker-output esp32`. It retains the laptop audio copy and an already-processed Parse result if playback fails; it does not repeat recording or care actions. Laptop playback remains the default.
- The amplifier diagnostic has a handover wiring overlay and configurable moderate test amplitude.
- Direct Wi-Fi source fixes retain partial USB setup commands, reject oversized or embedded-NUL lines, increase the setup task's stack, expose connection/button status, and use the same 200 ms microphone warm-up and left-channel selection for timed and held-button capture.

USB Wi-Fi setup handshaking worked, but joining the iPhone hotspot repeatedly caused brownout resets. No successful direct Wi-Fi recording-to-dashboard result is claimed. Wi-Fi investigation was paused in favor of the previously working Bluetooth route. The hosted installer binaries have not been repackaged with the latest source fixes.

## Software checks at handover

These checks ran without opening a board port or making recordings:

| Suite | Result |
| --- | --- |
| Host C firmware tests | 47 cases passed, including serial framing, direct capture, PCM32 mapping, peak limiting, partial writes, driver errors and session expiry |
| Bluetooth speaker helper | 7 tests passed with mocked Bluetooth RPC |
| Relay speaker completion checks | 4 tests passed with a mocked helper process |
| Parse pairing and remote-control relay | 5 tests passed with isolated storage and mocked service calls |
| Whitespace/error check | `git diff --check` passed |

Use the environments prepared by the [relay setup guide](../../tools/ESP32_VOICE_RELAY.md):

```sh
make -C firmware/test test
backend/.venv/bin/python -m unittest discover -s tools -p 'test_esp32_*py' -v
backend/.venv/bin/python -m unittest discover -s tools -p 'test_parse_*py' -v
```

The handover run used separate existing Python environments for Bluetooth dependencies and backend dependencies. An initial combined test discovery lacked `bleak` in the backend-only environment; all affected suites then passed in their appropriate environments. The setup guide installs both sets into one environment for the commands above.

## Resume point

Resume only when the user is ready. Start with the [Bluetooth relay guide](../../tools/ESP32_VOICE_RELAY.md) and keep laptop playback selected. Re-detect the intended ESP32 port; do not reuse another board's port.

The next unresolved physical check is the ESP32-to-amplifier common ground, including whether the breadboard rail is split or a jumper intermittent. No wiring changes were made as part of this pause. After that check, compare one known clip and record both the driver result and what was heard before changing another variable. Wi-Fi and the physical button remain deferred.
