# ESP32-S3 amplifier bench diagnostic

This separate ESP-IDF v5.4.2 application checks flash/PSRAM and sends a short
MAX98357A speaker test on request. It does not use Wi-Fi, a microphone, the
backend, device credentials, or the Parse interaction flow.

The default build leaves peripheral GPIOs untouched. Enable
`PARSE_BENCH_WIRING_CONFIRMED` only after checking the amplifier model, power,
speaker, and actual GPIO wiring. No tone plays automatically, including in an
audio-enabled build.

## Connected board observations, 9 October 2026

The ROM/eFuse/flash probe identified an ESP32-S3 revision 0.2 with 16 MB Quad
flash and 8 MB embedded PSRAM. Its USB-to-UART console is at 115200 baud.
The installed `careloop_amplifier_test` reports these assignments:

| Amplifier signal | GPIO reported by existing firmware |
| --- | --- |
| BCLK | 7 |
| LRC / WS / LRCLK | 15 |
| DIN | 16 |
| SD / enable | 17 |

These are software observations, not confirmation of the physical wires.
That program reports alternating one-second tones and silence; the user
reported no sound. This reproduces the symptom but does not identify a failed
amplifier. Its binary uses a 2 MB flash header and does not initialize PSRAM.

## Build

Use an ESP-IDF v5.4.2 environment and a full `firmware/` source copy in a path
without spaces. Generated `sdkconfig` and `build/` files should be absent in
that copy before its first configuration.

From `firmware/diagnostics/amplifier/`:

```sh
idf.py build
```

This uses the shared N16R8 UART memory profile and leaves audio disabled.
After checking the actual wiring, use `idf.py menuconfig` to set the four
signals under **Parse amplifier bench diagnostic** and enable the wiring
confirmation setting. Use `-1` for SD only if it is not connected to an ESP32
GPIO and the module's enable circuit has been checked. Rebuild after changing
configuration.

`sdkconfig.bench-observed` records the assignments from the old program, with
the confirmation setting still disabled. It is a reference for comparing the
wires, not an instruction to use those assignments on another board.

## Run and interpret

Flashing replaces the currently installed application. Preserve its bootloader,
partition table, settings and application first. The standard single-app
partition table used here matches the connected board's old offsets and sizes.

```sh
idf.py -p YOUR-PORT flash monitor
```

At boot, expect the detected flash size, PSRAM initialization/capacity, and a
64 KiB PSRAM allocation/pattern check. The pattern check is a small memory
check, not exhaustive validation of all 8 MB.

| Console command | Action |
| --- | --- |
| `t` | A 400 Hz tone for 500 ms, then 800 Hz for 500 ms, then idle. |
| `m` | Repeat the chip, flash, PSRAM and small memory report. |
| `s` | Keep the amplifier idle. A tone request already ends after about one second. |

The tone uses 16 kHz, 16-bit standard I²S stereo. Identical samples on left and
right avoid a channel-selection mismatch; amplitude is 1000/32767, about 3%
of full scale. Successful writes mean the ESP32 driver accepted the samples.
They do not prove electrical signals at the module or audible output.

If the tone is silent, check the actual supply between the module's VIN and
GND, common ground, speaker connections/continuity, and SD/enable level.
A logic analyzer or scope can distinguish absent clocks/data from an output
problem: during a tone, expect WS at 16 kHz and BCLK at 512 kHz, with data on DIN.
For a MAX98357A, the speaker connects between its two output terminals;
neither terminal is a ground return. Power and channel/shutdown requirements
come from the [MAX98357A datasheet](https://www.analog.com/media/en/technical-documentation/data-sheets/max98357a-max98357b.pdf).
