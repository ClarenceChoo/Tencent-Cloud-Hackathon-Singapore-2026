#include "careloop_state.h"
void careloop_state_init(careloop_machine_t *m, uint32_t now_ms) { m->state = CARELOOP_BOOT; m->entered_ms = now_ms; }
bool careloop_state_mic_enabled(careloop_state_t s) { return s == CARELOOP_RECORDING; }
bool careloop_state_amp_enabled(careloop_state_t s) { return s == CARELOOP_PLAYING; }
bool careloop_state_apply(careloop_machine_t *m, careloop_event_t e, uint32_t now_ms) {
    careloop_state_t before = m->state, next = before;
    if (e == CARELOOP_EV_FATAL) next = CARELOOP_ERROR;
    else switch (before) {
    case CARELOOP_BOOT: if (e == CARELOOP_EV_WIFI_UP) next = CARELOOP_IDLE; else if (e == CARELOOP_EV_WIFI_DOWN) next = CARELOOP_CONNECTING; break;
    case CARELOOP_CONNECTING: if (e == CARELOOP_EV_WIFI_UP) next = CARELOOP_IDLE; else if (e == CARELOOP_EV_WIFI_DOWN) next = CARELOOP_OFFLINE; break;
    case CARELOOP_OFFLINE: if (e == CARELOOP_EV_WIFI_UP) next = CARELOOP_IDLE; break;
    case CARELOOP_IDLE: if (e == CARELOOP_EV_PRESS) next = CARELOOP_CUE; else if (e == CARELOOP_EV_WIFI_DOWN) next = CARELOOP_OFFLINE; else if (e == CARELOOP_EV_RESPONSE) next = CARELOOP_PLAYING; break;
    case CARELOOP_CUE: if (e == CARELOOP_EV_RELEASE) next = CARELOOP_IDLE; else if (e == CARELOOP_EV_CUE_DONE) next = CARELOOP_RECORDING; break;
    case CARELOOP_RECORDING: if (e == CARELOOP_EV_RELEASE || e == CARELOOP_EV_CAPTURE_READY) next = CARELOOP_UPLOADING; break;
    case CARELOOP_UPLOADING: if (e == CARELOOP_EV_UPLOAD_OK) next = CARELOOP_WAITING; else if (e == CARELOOP_EV_UPLOAD_RETRY) next = CARELOOP_OFFLINE; break;
    case CARELOOP_WAITING: if (e == CARELOOP_EV_RESPONSE) next = CARELOOP_PLAYING; else if (e == CARELOOP_EV_WIFI_DOWN) next = CARELOOP_OFFLINE; break;
    case CARELOOP_PLAYING: if (e == CARELOOP_EV_PLAY_DONE || e == CARELOOP_EV_PLAY_INTERRUPT) next = CARELOOP_IDLE; break;
    default: break;
    }
    if (next == before) return false;
    m->state = next;
    m->entered_ms = now_ms;
    return true;
}
