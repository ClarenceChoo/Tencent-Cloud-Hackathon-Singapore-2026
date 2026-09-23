#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CARELOOP_SAMPLE_RATE 16000U
#define CARELOOP_WAV_HEADER_BYTES 44U
#define CARELOOP_MIN_PCM_BYTES 9600U
#define CARELOOP_MAX_PCM_BYTES 640000U
#define CARELOOP_MAX_WAV_BYTES (CARELOOP_WAV_HEADER_BYTES + CARELOOP_MAX_PCM_BYTES)

typedef enum { CARELOOP_WAV_OK = 0, CARELOOP_WAV_BAD_ARGUMENT, CARELOOP_WAV_BAD_FORMAT,
               CARELOOP_WAV_TOO_SHORT, CARELOOP_WAV_TOO_LARGE } careloop_wav_result_t;

void careloop_wav_write_header(uint8_t out[CARELOOP_WAV_HEADER_BYTES], uint32_t pcm_bytes);
bool careloop_wav_header_valid(const uint8_t header[CARELOOP_WAV_HEADER_BYTES], uint32_t *pcm_bytes);
careloop_wav_result_t careloop_wav_validate(const uint8_t *wav, size_t len, uint32_t *pcm_bytes);
int16_t careloop_inmp441_to_pcm16(int32_t slot_sample);
