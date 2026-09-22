# Local spoken prompts

These are English speech assets for local failure feedback, generated with macOS `say` (Samantha), converted to 16 kHz mono 16-bit PCM WAV, then rewritten with a basic RIFF header. They contain no personal data or provider credentials.

| File | Spoken text |
|---|---|
| `not_connected.wav` | Not connected. Please ask your caregiver to check Wi-Fi. |
| `not_sent.wav` | Your recording was not sent. Please try again when connected. |
| `receipt_unconfirmed.wav` | I cannot confirm whether that was received. Please check your care dashboard. |
| `low_battery.wav` | The battery is low. Please charge your cardholder. |

Only use `not_sent` when the firmware knows the upload did not reach the server. Use `receipt_unconfirmed` after a possible upload/commit with a missing acknowledgement. Never synthesize a saved acknowledgement locally before the server confirms commitment.

These files have valid WAV headers and nonzero samples. Intelligibility and loudness through the actual cardholder speaker still require bench testing.
