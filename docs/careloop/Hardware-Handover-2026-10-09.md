# CareLoop Smart Cardholder Hardware Handover

**Status date:** 9 October 2026

**Purpose:** Record the physical modules, soldering work, verified bench wiring, test firmware, observed results, and remaining amplifier fault so another team member can continue the hardware bring-up.

> [!IMPORTANT]
> This is the verified **bench wiring map** for the current ESP32-S3 unit. The repository firmware still leaves supplier-dependent GPIO values unassigned by default. Copy these pins into the firmware configuration only for a board whose printed labels and module type match this handover.

## Current conclusion

- ESP32-S3 build, flash, reset, and serial monitoring work with ESP-IDF 5.4.2.
- The INMP441 microphone was tested independently and responds to speech and claps.
- The GPIO18 push button was tested independently and reports pressed and released states.
- The nominal 8 ohm speaker produces an audible click during a brief 1.5 V battery test.
- The MAX98357A test firmware continuously writes I2S audio and reports `TONE` and `SILENCE` without an ESP-IDF error.
- No audible amplifier output has been heard yet. The remaining work is to verify power, enable, jumper continuity, and solder continuity with a digital multimeter before declaring the MAX98357A defective.

## Hardware inventory

| Item | Identification | Current use and notes |
| --- | --- | --- |
| Controller | ESP32-S3 development board using an ESP32-S3-WROOM-1 N16R8-class module | Two boards are available. Use the USB-C connector labelled `COM` for flashing and serial monitoring. |
| Microphone | INMP441 digital I2S microphone module | Powered from 3.3 V and verified independently at 16 kHz. |
| Amplifier | MAX98357A I2S mono Class-D amplifier breakout | Breakout is marked for 4–8 ohm speakers and up to 3 W. It uses a seven-pin signal/power header and a green two-position differential speaker terminal. |
| Speaker | Round nominal 8 ohm speaker, approximately 1 W | Red lead is positive and black lead is negative. The battery-click test passed. |
| User input | Momentary tactile push button | Connected between GPIO18 and ground; the firmware uses the ESP32 internal pull-up. |
| Prototype interconnect | Full-size solderless breadboard and Dupont jumper wires | Temporary only. Loose female Dupont contacts are a known possible fault source. |
| Planned final interconnect | 2.54 mm through-hole perfboard and insulated hookup wire | A 3 × 7 cm board is a possible starting size, but the final outline must be dry-fitted in the enclosure. Use approximately 24–26 AWG solid wire for short board links and 22–24 AWG stranded wire for power and speaker leads. |

The current bench is USB-powered. The battery, charger, and haptic hardware are not part of this tested wiring state.

## Complete bench wiring map

All grounds must be common. The two ESP32 pins labelled `3V3` are the same regulated 3.3 V rail. The amplifier `VIN` uses `5Vin`; only its `SD`/`EN` enable pin uses 3.3 V during the present diagnostic.

### INMP441 microphone

| INMP441 pin | ESP32 connection | Function |
| --- | --- | --- |
| `VDD` | `3V3` | Microphone power |
| `GND` | `GND` | Common ground |
| `SCK` / `BCLK` | `GPIO4` | I2S bit clock from the ESP32 |
| `WS` / `LRCLK` | `GPIO5` | I2S word-select clock from the ESP32 |
| `SD` | `GPIO6` | I2S microphone data into the ESP32 |
| `L/R` | `GND` | Selects the channel used by the current left-channel test |

### Push-to-talk button

| Button connection | ESP32 connection | Behaviour |
| --- | --- | --- |
| One switch side | `GPIO18` | Input with the ESP32 internal pull-up enabled |
| Opposite switch side | `GND` | Pressing the button pulls GPIO18 low |

The short tactile-button legs did not seat reliably by themselves, so jumper connections were used during the test.

### MAX98357A amplifier and speaker

| MAX98357A pin | ESP32 or load connection | Function and current configuration |
| --- | --- | --- |
| `VIN` | ESP32 `5Vin` | Amplifier power from the USB-powered board |
| `GND` | ESP32 `GND` | Common ground |
| `BCLK` | `GPIO7` | I2S speaker bit clock |
| `LRC` / `WS` | `GPIO15` | I2S left-right or word-select clock |
| `DIN` | `GPIO16` | I2S audio data from the ESP32 |
| `SD` / `EN` | `3V3` for the current diagnosis | Forces the amplifier enabled. `GPIO17` was the original firmware-controlled enable connection and can be restored after basic audio works. |
| `GAIN` | Leave unconnected | Uses the module's default gain. One header pin should therefore remain visibly unused. |
| Speaker `+` | Green terminal `+`, red speaker wire | Positive differential speaker output |
| Speaker `-` | Green terminal `-`, black speaker wire | Negative differential speaker output |

The speaker is nominally **8 ohms** and approximately **1 W**. The MAX98357A output is bridge-tied and differential: neither speaker terminal is ground. Never connect either speaker lead directly to an ESP32 GPIO, and never connect the speaker negative terminal to ESP32 ground.

## Soldering and mechanical work

### Seven-pin amplifier header

- A 2.54 mm male header is soldered to the seven MAX98357A control and power holes.
- Each joint should wet both the circular PCB pad and the metal pin, forming a small smooth fillet without bridging to the next pad.
- The header was reflowed after the first silent test.
- Do not apply more heat until continuity or voltage measurements identify a specific bad joint.
- On the breadboard, orient the header along the breadboard length so every amplifier pin enters a different numbered row.

### Green speaker terminal

- The two-position terminal is installed in the two large speaker-output holes.
- Its wire openings face outward so the speaker leads can enter the terminal.
- A small plastic gap between the green housing and the amplifier PCB is acceptable. Electrical contact depends on the terminal's metal legs and solder joints, not on the plastic housing sitting perfectly flush.
- Insert bare copper fully into the terminal and tighten the screws without trapping insulation.
- Red speaker wire goes to `+`; black speaker wire goes to `-`.

### Soldering safety and inspection

- Disconnect USB and every other power source before soldering or resistance testing.
- Secure the board mechanically. Heat the pad and pin together for roughly two to three seconds, add a small amount of solder, and let the joint cool without movement.
- Inspect for adjacent-pad bridges, dull or cracked joints, solder balls, or pads that move.
- Avoid repeatedly heating the amplifier IC or nearby surface-mount parts.
- Add strain relief in the final enclosure so movement of the power and speaker wires is not transferred into the solder joints.

The solderless breadboard is only for bring-up and does not need to fit in the enclosure. Move to perfboard or secured direct wiring only after every required subsystem works reliably on the bench.

## Bench diagnostic firmware

### Test projects used locally

| Project | Local project directory | Diagnostic behaviour |
| --- | --- | --- |
| Microphone test | `mic-test` | 16 kHz I2S receive test with live level and peak output |
| Button test | `button-test` | GPIO18 active-low input with internal pull-up and `PRESSED` / `RELEASED` logs |
| Amplifier test | `amplifier-test` | 16 kHz, 16-bit stereo I2S output; 500 Hz square wave; amplitude 8000; approximately one second of tone followed by one second of silence |

These small bench projects were run separately from the integrated repository firmware. Their local source directories are under `C:\Users\user\Documents\ChatGPT\Bumblebee` on the original development laptop.

### Windows ESP-IDF commands

Open PowerShell and run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
. C:\esp\v5.4.2\esp-idf\export.ps1
Get-CimInstance Win32_SerialPort | Select-Object DeviceID, Name
cd C:\Users\user\Documents\ChatGPT\Bumblebee\amplifier-test
idf.py -p COM4 flash monitor
```

Replace `COM4` with the currently detected port. The board has appeared as both COM3 and COM4, so do not assume the number is fixed.

- Use the ESP32 USB-C port labelled `COM`, not the separate USB/OTG connector, for the expected flashing and monitoring workflow.
- Use `Ctrl+]` to leave the serial monitor. Leaving the monitor does not stop firmware already running on the ESP32.
- Pressing `RST` restarts the firmware. Logs are visible only while a serial monitor is connected.
- If ESP-IDF reports that the project was configured using another Python environment, run `idf.py fullclean`, then rebuild and flash.

## Completed tests and observations

| Test | Result | Interpretation |
| --- | --- | --- |
| ESP32-S3 build and flash | Pass | Toolchain and board communication work. |
| Serial monitor | Pass | Boot and application logs are visible through the COM USB-C connector. |
| INMP441 level test | Pass | The digital microphone wiring and GPIO4/GPIO5/GPIO6 mapping work. |
| GPIO18 button test | Pass | The button and active-low input path work. |
| Speaker battery-click test | Pass | The speaker coil and attached speaker leads respond electrically. |
| Amplifier firmware loop | Pass at software level | The application repeatedly writes I2S buffers and logs `TONE` and `SILENCE` without an ESP-IDF error. |
| Acoustic amplifier output | Fail / unresolved | No tone is heard despite wiring checks and solder rework. |
| Laptop mute check | Not relevant | The signal is generated by the ESP32 and amplifier; laptop volume does not control the speaker. |

## Digital multimeter checks

Put the black meter lead in `COM` and the red lead in the voltage/ohms socket. Do not use the ampere or 10 A socket for these checks.

Perform resistance and continuity measurements only with USB disconnected. Power the board only for the two DC-voltage measurements.

| Condition and setting | Probe points | Expected result | Suspect if outside range |
| --- | --- | --- | --- |
| Unpowered continuity | Both ends of each removable jumper wire | Steady beep and about 0–2 ohms, including while gently bending the wire | Open or intermittent jumper, or loose Dupont contact |
| Unpowered continuity | Each amplifier header pin to its own solder pad | Steady beep and about 0–2 ohms | Header solder joint is not electrically connected |
| Unpowered resistance | Across the two green terminal screws with the speaker connected | About 6–10 ohms for the nominal 8 ohm speaker | `OL` indicates an open clamp, lead, or terminal joint; near 0 ohms indicates a short |
| Powered DC voltage | Black probe on amplifier `GND`, red probe on amplifier `VIN` | About 4.7–5.2 V | Power jumper, ESP32 `5Vin`, or VIN solder fault |
| Powered DC voltage | Black probe on amplifier `GND`, red probe on amplifier `SD` / `EN` | About 3.3 V | Enable jumper or SD solder fault |

A basic DMM cannot reliably prove the fast `BCLK`, `LRC`, and `DIN` waveforms. The filterless Class-D output can also confuse an ordinary AC-voltage reading. Use an oscilloscope or logic analyser for waveform proof, or use known-good GPIO pins and jumper wires that pass continuity.

## Amplifier fault decision

1. If `VIN` is not near 5 V at the amplifier, repair or replace the VIN/GND jumper and inspect the matching solder joint.
2. If `SD`/`EN` is not near 3.3 V, repair that connection. Keep `GAIN` unconnected.
3. If the green terminal does not measure approximately the speaker resistance, re-strip and clamp the speaker leads or repair the terminal joint.
4. If a jumper fails continuity or works only while held at an angle, replace it.
5. If every electrical check passes, the firmware still reports `TONE` and `SILENCE`, and no output is heard, treat the MAX98357A module as defective or heat-damaged. Replace it instead of applying more soldering heat.

## Integration and enclosure notes

- Keep the microphone and speaker physically separated and aligned with their respective enclosure openings to reduce feedback.
- Retain development access to the COM USB-C connector, reset control, and wiring.
- Do not freeze the perfboard outline until the actual board, connectors, speaker, button, and cable clearances have been dry-fitted.
- The current Rev C enclosure reference uses a 20.6 mm speaker seat, 24 mm retaining ring, 2.0 mm microphone port, two USB-C openings, and a 12.5 mm side-button opening. Confirm the actual clone-module dimensions before the final print.

## Fallback if the amplifier cannot be replaced in time

The silent amplifier does not block a software-flow demonstration. The verified button and microphone can still capture and upload a turn, while returned TTS audio plays through a laptop or phone speaker. Record onboard playback as pending hardware integration and preserve the enclosure speaker location for a replacement module.

Never drive the 8 ohm speaker directly from an ESP32 GPIO.

## Recommended next actions

1. Run the five DMM checks and record the measured values below.
2. Use only jumper wires that pass continuity, then repeat the amplifier tone test once.
3. If the amplifier remains silent after the electrical checks pass, stop reworking it and replace the MAX98357A when one is available.
4. Continue the button, microphone, Wi-Fi, backend, and response flow using laptop or phone playback if a replacement cannot arrive in time.
5. Move to perfboard only after all required modules work reliably on the bench.

## Handover measurement record

| Field | Value to record |
| --- | --- |
| ESP32 board assigned to hardware | |
| ESP32 board assigned to software | |
| Current Windows COM port | |
| Amplifier VIN measurement | V |
| Amplifier SD/EN measurement | V |
| Speaker resistance through terminal | ohms |
| Jumper continuity result | Pass / Fail / Replaced |
| Amplifier decision | Continue testing / Replace / Use laptop fallback |
