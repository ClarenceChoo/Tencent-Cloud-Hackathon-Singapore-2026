#include "careloop_app.h"
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "esp_log.h"
#include "esp_system.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/task.h"
#include "careloop_protocol.h"

static const char *TAG="careloop";
static careloop_app_t app;
#if !CONFIG_CARELOOP_DIRECT_WIFI
static void pulse(unsigned on_ms, unsigned off_ms, unsigned count) { for(unsigned i=0;i<count;i++){careloop_haptic(&app.board,true);vTaskDelay(pdMS_TO_TICKS(on_ms));careloop_haptic(&app.board,false);if(i+1<count)vTaskDelay(pdMS_TO_TICKS(off_ms));} }
static bool debounced_press(void) { if(!careloop_ptt_pressed(&app.board))return false;vTaskDelay(pdMS_TO_TICKS(40));return careloop_ptt_pressed(&app.board); }
static void wait_for_release(void) { while(careloop_ptt_pressed(&app.board)) vTaskDelay(pdMS_TO_TICKS(10)); }
static void wifi_setup_if_requested(void) {
  if (!app.settings.configured || app.settings.room_id[0] || !careloop_ptt_pressed(&app.board)) return;
  const int64_t started = esp_timer_get_time();
  while (careloop_ptt_pressed(&app.board)) {
    if (esp_timer_get_time() - started >= 5000000) {
      memset(app.settings.wifi_ssid, 0, sizeof(app.settings.wifi_ssid));
      memset(app.settings.wifi_password, 0, sizeof(app.settings.wifi_password));
      app.settings.configured = false;
      /* Keep the device token, setup password, backend and replay ledger. */
      ESP_ERROR_CHECK(careloop_settings_save(&app.settings));
      ESP_LOGI(TAG, "Wi-Fi setup requested; release the talk button");
      pulse(180, 100, 2);
      wait_for_release();
      return;
    }
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}
static void interaction_task(void *unused) {
  (void)unused;
  for (;;) {
    careloop_network_play_pending(&app);
    if (!debounced_press()) { vTaskDelay(pdMS_TO_TICKS(20)); continue; }
    if (!careloop_wifi_connected() || !app.settings.device_token[0]) { if(xSemaphoreTake(app.audio_lock,pdMS_TO_TICKS(50))==pdTRUE){careloop_play_local_prompt(&app.board,CARELOOP_PROMPT_NOT_CONNECTED);xSemaphoreGive(app.audio_lock);} pulse(120,80,2); while(careloop_ptt_pressed(&app.board))vTaskDelay(pdMS_TO_TICKS(10)); continue; }
    if (xSemaphoreTake(app.audio_lock,pdMS_TO_TICKS(50)) != pdTRUE) { /* Playback sees this held press and stops; retry it as a capture. */ vTaskDelay(pdMS_TO_TICKS(100)); continue; }
    char capture_context[CARELOOP_ID_MAX]={0}; bool awaiting=false;
    xSemaphoreTake(app.state_lock,portMAX_DELAY); if(!careloop_context_is_active(time(NULL),time(NULL)>1700000000,app.context_expires_at,app.context_id[0])){app.context_id[0]=0;app.context_expires_at=0;} awaiting=app.awaiting_turn_id[0]!=0; snprintf(capture_context,sizeof(capture_context),"%s",app.context_id); xSemaphoreGive(app.state_lock);
    if(awaiting){/* Three short pulses mean the accepted turn is still processing. */pulse(45,45,3);wait_for_release();xSemaphoreGive(app.audio_lock);continue;}
    pulse(100,0,1); vTaskDelay(pdMS_TO_TICKS(30));
    if (!careloop_ptt_pressed(&app.board)) { xSemaphoreGive(app.audio_lock); continue; } /* Release during cue cancels. */
    uint8_t *wav=NULL; size_t len=0; esp_err_t e=careloop_capture_wav(&app.board,&wav,&len);
    if(e==ESP_ERR_INVALID_SIZE) { pulse(60,60,1); xSemaphoreGive(app.audio_lock); continue; } /* <300 ms accidental clip */
    if(e!=ESP_OK) { ESP_LOGW(TAG,"capture unavailable (%s)",esp_err_to_name(e));pulse(180,80,3);xSemaphoreGive(app.audio_lock);continue; }
    char turn[CARELOOP_ID_MAX]={0}, key[37]; bool accepted=false, attempted=false, any_attempt=false; /* UUID is allocated once for this captured clip and reused on every retry. */
    uint32_t r[4]; esp_fill_random(r,sizeof(r)); snprintf(key,sizeof(key),"%08lx-%04lx-%04lx-%04lx-%08lx%04lx",(unsigned long)r[0],(unsigned long)(r[1]>>16),(unsigned long)((r[1]&0xfff)|0x4000),(unsigned long)((r[2]>>16&0x3fff)|0x8000),(unsigned long)(r[2]&0xffff),(unsigned long)r[3]);
    int64_t retain_until=esp_timer_get_time()+60000000LL;
    for(unsigned attempt=0;attempt<4 && !accepted && esp_timer_get_time()+10000000LL<retain_until;attempt++) { e=careloop_upload_turn(&app,wav,len,capture_context,key,&attempted,turn);any_attempt|=attempted;accepted=(e==ESP_OK);if(!accepted&&attempt<3){uint32_t wait=careloop_retry_delay_ms(attempt,(uint32_t)esp_timer_get_time());if(esp_timer_get_time()+(int64_t)wait*1000LL<retain_until)vTaskDelay(pdMS_TO_TICKS(wait));} }
    free(wav); /* One pending clip is retained only during the bounded retry interval, never on flash. */
    if(!accepted) { careloop_play_local_prompt(&app.board,any_attempt?CARELOOP_PROMPT_RECEIPT_UNCONFIRMED:CARELOOP_PROMPT_NOT_SENT); pulse(180,100,3); } else { xSemaphoreTake(app.state_lock,portMAX_DELAY); snprintf(app.awaiting_turn_id,sizeof(app.awaiting_turn_id),"%s",turn); xSemaphoreGive(app.state_lock); pulse(50,50,2); }
    /* A 20-second hold ends one turn; require a physical release before another. */
    wait_for_release(); xSemaphoreGive(app.audio_lock);
  }
}
#endif
void app_main(void) {
  memset(&app,0,sizeof(app)); ESP_ERROR_CHECK(careloop_settings_load(&app.settings,&app.ledger)); ESP_ERROR_CHECK(careloop_board_init(&app.board));
  app.audio_lock=xSemaphoreCreateMutex(); app.state_lock=xSemaphoreCreateMutex(); app.ledger_lock=xSemaphoreCreateMutex(); if(!app.audio_lock||!app.state_lock||!app.ledger_lock){ESP_LOGE(TAG,"No memory for device locks");return;}
  if(!careloop_board_microphone_ready(&app.board)) ESP_LOGW(TAG,"Microphone remains disabled: microphone GPIO map has not been configured");
#if !CONFIG_CARELOOP_DIRECT_WIFI
  wifi_setup_if_requested();
#endif
  ESP_ERROR_CHECK(careloop_wifi_start(&app));
  xTaskCreate(careloop_wifi_command_task,"parse_wifi_serial",4096,&app,4,NULL);
#if CONFIG_CARELOOP_DIRECT_WIFI
  careloop_direct_start(&app);
  xTaskCreate(careloop_direct_interaction_task,"parse_direct_interaction",6144,&app,5,NULL);
#else
  if (app.settings.room_id[0]) { careloop_direct_start(&app); xTaskCreate(careloop_direct_interaction_task,"parse_direct_interaction",6144,&app,5,NULL); }
  else { careloop_network_start(&app); xTaskCreate(interaction_task,"careloop_interaction",6144,NULL,5,NULL); }
#endif
}
