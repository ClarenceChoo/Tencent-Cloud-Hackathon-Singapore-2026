#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef enum { CARELOOP_BOOT, CARELOOP_CONNECTING, CARELOOP_IDLE, CARELOOP_CUE,
  CARELOOP_RECORDING, CARELOOP_UPLOADING, CARELOOP_WAITING, CARELOOP_PLAYING,
  CARELOOP_OFFLINE, CARELOOP_ERROR } careloop_state_t;
typedef enum { CARELOOP_EV_WIFI_UP, CARELOOP_EV_WIFI_DOWN, CARELOOP_EV_PRESS,
  CARELOOP_EV_RELEASE, CARELOOP_EV_CUE_DONE, CARELOOP_EV_CAPTURE_READY,
  CARELOOP_EV_UPLOAD_OK, CARELOOP_EV_UPLOAD_RETRY, CARELOOP_EV_RESPONSE,
  CARELOOP_EV_PLAY_DONE, CARELOOP_EV_PLAY_INTERRUPT, CARELOOP_EV_FATAL } careloop_event_t;
typedef struct { careloop_state_t state; uint32_t entered_ms; } careloop_machine_t;
void careloop_state_init(careloop_machine_t *m, uint32_t now_ms);
bool careloop_state_apply(careloop_machine_t *m, careloop_event_t event, uint32_t now_ms);
bool careloop_state_mic_enabled(careloop_state_t state);
bool careloop_state_amp_enabled(careloop_state_t state);
