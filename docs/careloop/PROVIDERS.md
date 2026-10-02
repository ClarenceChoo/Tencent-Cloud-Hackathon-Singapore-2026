# Speech and interpretation providers

The device sends WAV recordings only to the CareLoop backend. The backend owns cloud credentials and calls the provider adapters in `backend/app/providers.py`. It validates model output as an untrusted proposal; model output never commits records by itself.

The optional `X-Care-Intent` turn hint reaches the interpreter only as one allowlisted context field. It may be `health_note`, `medication_report`, `measurement`, `support_request`, or absent for free speech. The prompt instructs the model to follow the transcript and an active proposal context first. The backend still validates every material field and requires a separate explicit confirmation; selecting a purpose cannot establish an event, reading, dose status or recipient.

## Modes

- `CARELOOP_PROVIDER=unconfigured` (default): dashboards and care-record API work. Speech requests fail with an explicit unavailable response.
- `CARELOOP_PROVIDER=fixture`, with `CARELOOP_TESTING=true`: developer tests map known WAV hashes to fixed transcripts. This is not speech recognition. The operator must supply a reply WAV that identifies itself as developer audio; it does not prove that the pendant reads back actual record details. Never use this mode for a real-user or physical voice acceptance demonstration.
- `CARELOOP_PROVIDER=tencent`: Tencent short-utterance ASR and TTS plus a configured OpenAI-compatible language-model endpoint. Actual account access, voice/model availability and processing locations must be checked before live use.

## Live server environment

Set these on the server only; do not paste secrets into the dashboard, firmware, repository, or screenshots.

```dotenv
CARELOOP_PROVIDER=tencent
TENCENT_SECRET_ID=replace-on-server
TENCENT_SECRET_KEY=replace-on-server
# Optional only for temporary Tencent credentials:
TENCENT_SESSION_TOKEN=
CARELOOP_ASR_HOST=asr.tencentcloudapi.com
CARELOOP_ASR_ENGINE=16k_en
CARELOOP_TTS_HOST=tts.intl.tencentcloudapi.com
# Select an English-capable voice enabled in YOUR account:
CARELOOP_TTS_VOICE_TYPE=
CARELOOP_TTS_PRIMARY_LANGUAGE=2
# Set the HTTPS endpoint and model enabled in YOUR account:
CARELOOP_LLM_BASE_URL=
CARELOOP_LLM_MODEL=
CARELOOP_LLM_API_KEY=
```

Mainland and international Tencent service access may differ; backend hosting in Singapore does not establish the processing location of these services. The ASR and TTS endpoint defaults are documented API hosts, not a claim that one account can access both. The adapter allows the corresponding `asr`/`tts` mainland or international Tencent API hosts. Do not change an endpoint to forward cloud credentials to another domain.

Tencent's Hunyuan documentation describes an OpenAI-compatible `/v1/chat/completions` endpoint and notes service migration toward TokenHub. Configure the currently available service from your account rather than assuming a particular model or new-account entitlement. The adapter uses ordinary non-streaming chat completions and requires valid JSON output; it does not depend on a provider-specific response-format parameter.

## Device audio contract

Input is 16 kHz, mono, signed 16-bit PCM WAV, 0.3–20 seconds. ASR uploads bytes using SentenceRecognition. TTS requests PCM at 16 kHz and wraps it in a canonical WAV header. The backend splits replies into synthesis requests of at most 160 characters and splits again when a returned clip exceeds 20 seconds. It returns ordered `audio_paths`, which the firmware plays sequentially with microphone capture stopped. The sequence is limited to 20 clips and 120 seconds total; over-limit content fails explicitly instead of being truncated. `audio_path` retains the first clip for compatibility. Test actual care flows against the selected voice before physical acceptance.

Network timeouts, invalid JSON, provider errors and invalid audio return sanitised errors. Provider bodies, transcripts and keys are never included in these client-facing errors. TLS validation is enabled and redirects are not followed. API keys belong to the backend; each device uses a separate revocable CareLoop credential.

## Evidence

### Reviewed vocabulary capability (2 October 2026)

The current adapter calls Tencent `SentenceRecognition` version `2019-06-14` with `EngSerViceType=16k_en`. The [official SentenceRecognition request documentation](https://cloud.tencent.com/document/api/1093/35646) lists optional `HotwordId` and `HotwordList` fields. The temporary list uses a `term|weight` format, limits each term to 30 characters (at most 10 Chinese characters), and accepts at most 128 terms. It cautions that weight 100 forces a same-sound replacement only for the Chinese `8k_zh` and `16k_zh` engines. Those limits and semantics differ from the reviewed vocabulary's 80-character names and aliases. The documentation does not establish this application's account entitlement, English-engine efficacy, or safe weights for near-sounding medicines. No such proof is available here, so the adapter does not send a hotword parameter and reports ASR vocabulary as unsupported. Normal ASR and advisory interpreter context remain available. An intercepted request test checks that no extra ASR field is sent.

The outcome is a capability report, not an accuracy claim. Any future activation requires a verified account and engine, provider-specific validation and a fictional material-error evaluation before live use.

Automated tests verify request formatting, credential signing properties, audio validation, output boundaries, context minimisation and failure handling using intercepted HTTP responses. They do not prove service entitlement, speech accuracy, actual TTS quality, processing region or latency. No paid live call has been made as part of these tests.

Primary references checked during implementation:

- [Tencent SentenceRecognition](https://cloud.tencent.com/document/api/1093/35646)
- [Tencent TextToVoice](https://intl.cloud.tencent.com/document/product/1154/48916?lang=en)
- [Tencent API signature v3](https://www.tencentcloud.com/pt/document/api/242/54220)
- [Tencent Hunyuan compatible endpoint and migration notice](https://cloud.tencent.com/document/product/1729/111007)
