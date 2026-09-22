#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "careloop_protocol.h"

#define CARELOOP_TEXT_MAX 256
#define CARELOOP_URL_MAX 192
#define CARELOOP_WIFI_MAX 64
typedef enum { CARELOOP_PROMPT_NOT_CONNECTED, CARELOOP_PROMPT_NOT_SENT,
               CARELOOP_PROMPT_RECEIPT_UNCONFIRMED, CARELOOP_PROMPT_LOW_BATTERY,
               CARELOOP_PROMPT_PROCESSING_FAILED, CARELOOP_PROMPT_SAVED } careloop_prompt_t;
typedef struct {
  char wifi_ssid[33]; char wifi_password[65]; char backend_url[CARELOOP_URL_MAX];
  char device_token[257]; char setup_password[17]; bool configured;
} careloop_settings_t;
typedef struct { int mic_bclk, mic_ws, mic_data, spk_bclk, spk_ws, spk_data, amp_enable, ptt, haptic; } careloop_board_t;
typedef struct { char command_id[CARELOOP_ID_MAX]; char context_id[CARELOOP_ID_MAX]; char audio_path[CARELOOP_URL_MAX]; uint32_t plan_version; int64_t expires_at; int64_t received_us; bool valid; } careloop_pending_command_t;
typedef struct { char command_id[CARELOOP_ID_MAX]; char context_id[CARELOOP_ID_MAX]; int64_t expires_at;
  char paths[CARELOOP_REPLY_CLIPS_MAX][CARELOOP_URL_MAX]; size_t count; bool valid; } careloop_pending_checkin_t;
typedef struct {
  careloop_settings_t settings; careloop_ledger_t ledger; careloop_board_t board;
  SemaphoreHandle_t audio_lock; SemaphoreHandle_t state_lock; SemaphoreHandle_t ledger_lock; careloop_pending_command_t pending; careloop_pending_checkin_t checkin; uint32_t active_plan_version;
  char context_id[CARELOOP_ID_MAX]; int64_t context_expires_at; char awaiting_turn_id[CARELOOP_ID_MAX];
  char pending_reply_paths[CARELOOP_REPLY_CLIPS_MAX][CARELOOP_URL_MAX]; size_t pending_reply_count; int64_t pending_reply_expires_at;
  char pending_reply_context_id[CARELOOP_ID_MAX]; bool pending_reply_context_present; careloop_prompt_t pending_prompt; bool pending_prompt_valid; bool time_valid;
} careloop_app_t;

esp_err_t careloop_settings_load(careloop_settings_t *settings, careloop_ledger_t *ledger);
esp_err_t careloop_settings_save(const careloop_settings_t *settings);
esp_err_t careloop_ledger_save(const careloop_ledger_t *ledger);
esp_err_t careloop_board_init(careloop_board_t *board);
bool careloop_board_audio_ready(const careloop_board_t *board);
bool careloop_ptt_pressed(const careloop_board_t *board);
void careloop_haptic(const careloop_board_t *board, bool on);
void careloop_amp(const careloop_board_t *board, bool on);
esp_err_t careloop_capture_wav(const careloop_board_t *board, uint8_t **wav, size_t *wav_len);
esp_err_t careloop_play_local_prompt(const careloop_board_t *board, careloop_prompt_t prompt);
esp_err_t careloop_play_wav_stream(const careloop_board_t *board, const uint8_t *header, const uint8_t *first, size_t first_len,
                                    int (*read_more)(void *ctx, uint8_t *dst, size_t cap), void *ctx);
esp_err_t careloop_wifi_start(careloop_app_t *app);
bool careloop_wifi_connected(void);
void careloop_network_start(careloop_app_t *app);
esp_err_t careloop_upload_turn(careloop_app_t *app, const uint8_t *wav, size_t wav_len, const char *context_id, const char *idempotency_key, bool *request_attempted, char turn_id[CARELOOP_ID_MAX]);
void careloop_network_handle_json(careloop_app_t *app, const char *json, size_t len);
void careloop_network_play_pending(careloop_app_t *app);
