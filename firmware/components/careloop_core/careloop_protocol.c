#include "careloop_protocol.h"
#include <string.h>

bool careloop_relative_audio_path_valid(const char *p) {
    return p && p[0] == '/' && p[1] != '/' && strstr(p, "://") == NULL && strstr(p, "..") == NULL &&
           strncmp(p, "/v1/device/audio/", 17) == 0;
}
bool careloop_audio_path_list_valid(const char *const *paths, size_t count) {
    if (!paths || count == 0 || count > CARELOOP_REPLY_CLIPS_MAX) return false;
    for (size_t i = 0; i < count; ++i) if (!careloop_relative_audio_path_valid(paths[i])) return false;
    return true;
}
size_t careloop_reply_path_select(const char *const *paths, size_t count, const char *fallback,
                                  const char *out[CARELOOP_REPLY_CLIPS_MAX]) {
    if (!out) return 0;
    if (count) {
        if (!careloop_audio_path_list_valid(paths, count)) return 0;
        for (size_t i = 0; i < count; ++i) out[i] = paths[i];
        return count;
    }
    if (!careloop_relative_audio_path_valid(fallback)) return 0;
    out[0] = fallback;
    return 1;
}
bool careloop_command_is_playable(int64_t now, int64_t expiry, bool time_ok, uint32_t current, uint32_t command) {
    return time_ok && expiry > now && current != 0 && current == command;
}
bool careloop_turn_status_is_processing(const char *status) {
    return status && (!strcmp(status, "accepted") || !strcmp(status, "transcribing") ||
                      !strcmp(status, "transcribed") || !strcmp(status, "processing"));
}
bool careloop_turn_status_is_terminal(const char *status) {
    return status && (!strcmp(status, "committed") || !strcmp(status, "awaiting_confirmation") ||
                      !strcmp(status, "completed") || !strcmp(status, "clarification_required") ||
                      !strcmp(status, "failed"));
}
bool careloop_context_is_active(int64_t now, bool time_valid, int64_t expires_at, bool has_context) {
    return has_context && (!time_valid || expires_at > now);
}
careloop_ledger_entry_t *careloop_ledger_find(careloop_ledger_t *l, const char *id) {
    if (!l || !id) return NULL;
    for (size_t i = 0; i < CARELOOP_LEDGER_SLOTS; ++i)
        if (l->entries[i].command_id[0] && strcmp(l->entries[i].command_id, id) == 0) return &l->entries[i];
    return NULL;
}
bool careloop_ledger_should_suppress(const careloop_ledger_entry_t *e) {
    return e && e->stage != CARELOOP_CMD_NONE && e->stage != CARELOOP_CMD_FAILED;
}
bool careloop_retry_is_transient(int status) { return status == 0 || status == 408 || status == 429 || status >= 500; }
uint32_t careloop_retry_delay_ms(unsigned attempt, uint32_t jitter) {
    static const uint32_t base[] = {1000, 2000, 4000, 8000}; return base[attempt > 3 ? 3 : attempt] + (jitter % 251);
}
