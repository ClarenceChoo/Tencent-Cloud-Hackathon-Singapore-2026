#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CARELOOP_ID_MAX 80
#define CARELOOP_LEDGER_SLOTS 24
#define CARELOOP_REPLY_CLIPS_MAX 20
typedef enum { CARELOOP_CMD_NONE, CARELOOP_CMD_RECEIVED, CARELOOP_CMD_PLAYING,
  CARELOOP_CMD_COMPLETED, CARELOOP_CMD_INTERRUPTED, CARELOOP_CMD_FAILED,
  CARELOOP_CMD_EXPIRED, CARELOOP_CMD_UNKNOWN } careloop_command_stage_t;
typedef struct { char command_id[CARELOOP_ID_MAX]; uint32_t plan_version; int64_t expires_at;
                 careloop_command_stage_t stage; } careloop_ledger_entry_t;
typedef struct { careloop_ledger_entry_t entries[CARELOOP_LEDGER_SLOTS]; } careloop_ledger_t;
bool careloop_relative_audio_path_valid(const char *path);
bool careloop_audio_path_list_valid(const char *const *paths, size_t count);
size_t careloop_reply_path_select(const char *const *paths, size_t count, const char *fallback,
                                  const char *out[CARELOOP_REPLY_CLIPS_MAX]);
bool careloop_command_is_playable(int64_t now_epoch, int64_t expires_at, bool time_valid,
                                  uint32_t current_plan_version, uint32_t command_plan_version);
careloop_ledger_entry_t *careloop_ledger_find(careloop_ledger_t *ledger, const char *command_id);
bool careloop_ledger_should_suppress(const careloop_ledger_entry_t *entry);
bool careloop_retry_is_transient(int http_status);
uint32_t careloop_retry_delay_ms(unsigned attempt, uint32_t jitter_ms);
