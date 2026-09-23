#include "careloop_wav.h"
#include <string.h>

static void put16(uint8_t *p, uint16_t x) { p[0] = (uint8_t)x; p[1] = (uint8_t)(x >> 8); }
static void put32(uint8_t *p, uint32_t x) { p[0] = (uint8_t)x; p[1] = (uint8_t)(x >> 8); p[2] = (uint8_t)(x >> 16); p[3] = (uint8_t)(x >> 24); }
static uint16_t get16(const uint8_t *p) { return (uint16_t)p[0] | ((uint16_t)p[1] << 8); }
static uint32_t get32(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }

void careloop_wav_write_header(uint8_t out[CARELOOP_WAV_HEADER_BYTES], uint32_t pcm_bytes) {
    memcpy(out, "RIFF", 4); put32(out + 4, pcm_bytes + 36); memcpy(out + 8, "WAVEfmt ", 8);
    put32(out + 16, 16); put16(out + 20, 1); put16(out + 22, 1); put32(out + 24, CARELOOP_SAMPLE_RATE);
    put32(out + 28, CARELOOP_SAMPLE_RATE * 2); put16(out + 32, 2); put16(out + 34, 16);
    memcpy(out + 36, "data", 4); put32(out + 40, pcm_bytes);
}

bool careloop_wav_header_valid(const uint8_t wav[CARELOOP_WAV_HEADER_BYTES], uint32_t *pcm_bytes) {
    if (!wav || !pcm_bytes) return false;
    if (memcmp(wav, "RIFF", 4) || memcmp(wav + 8, "WAVE", 4) || memcmp(wav + 12, "fmt ", 4) ||
        get32(wav + 16) != 16 || get16(wav + 20) != 1 || get16(wav + 22) != 1 ||
        get32(wav + 24) != CARELOOP_SAMPLE_RATE || get16(wav + 34) != 16 || memcmp(wav + 36, "data", 4)) return false;
    *pcm_bytes = get32(wav + 40);
    return !(*pcm_bytes & 1U) && *pcm_bytes <= CARELOOP_MAX_PCM_BYTES;
}
careloop_wav_result_t careloop_wav_validate(const uint8_t *wav, size_t len, uint32_t *pcm_bytes) {
    if (!wav || !pcm_bytes) return CARELOOP_WAV_BAD_ARGUMENT;
    if (len < CARELOOP_WAV_HEADER_BYTES) return CARELOOP_WAV_BAD_FORMAT;
    uint32_t pcm;
    if (!careloop_wav_header_valid(wav, &pcm)) return CARELOOP_WAV_BAD_FORMAT;
    if (pcm & 1U || pcm + CARELOOP_WAV_HEADER_BYTES != len) return CARELOOP_WAV_BAD_FORMAT;
    if (pcm < CARELOOP_MIN_PCM_BYTES) return CARELOOP_WAV_TOO_SHORT;
    if (pcm > CARELOOP_MAX_PCM_BYTES) return CARELOOP_WAV_TOO_LARGE;
    *pcm_bytes = pcm; return CARELOOP_WAV_OK;
}

int16_t careloop_inmp441_to_pcm16(int32_t slot_sample) {
    /* INMP441 data is 24-bit signed, left-aligned in a 32-bit I2S slot. Arithmetic
       shift preserves sign and drops the least-significant eight microphone bits. */
    return (int16_t)(slot_sample >> 16);
}
