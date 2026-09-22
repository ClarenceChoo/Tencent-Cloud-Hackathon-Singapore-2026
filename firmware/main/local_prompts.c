#include "careloop_app.h"
#include <stddef.h>
#include "careloop_wav.h"

extern const uint8_t not_connected[] asm("_binary_not_connected_wav_start");
extern const uint8_t not_connected_end[] asm("_binary_not_connected_wav_end");
extern const uint8_t not_sent[] asm("_binary_not_sent_wav_start");
extern const uint8_t not_sent_end[] asm("_binary_not_sent_wav_end");
extern const uint8_t receipt_unconfirmed[] asm("_binary_receipt_unconfirmed_wav_start");
extern const uint8_t receipt_unconfirmed_end[] asm("_binary_receipt_unconfirmed_wav_end");
extern const uint8_t low_battery[] asm("_binary_low_battery_wav_start");
extern const uint8_t low_battery_end[] asm("_binary_low_battery_wav_end");
extern const uint8_t processing_failed[] asm("_binary_processing_failed_wav_start");
extern const uint8_t processing_failed_end[] asm("_binary_processing_failed_wav_end");
extern const uint8_t saved[] asm("_binary_saved_wav_start");
extern const uint8_t saved_end[] asm("_binary_saved_wav_end");
static int exhausted(void *ctx, uint8_t *dst, size_t cap) { (void)ctx; (void)dst; (void)cap; return 0; }
esp_err_t careloop_play_local_prompt(const careloop_board_t *b, careloop_prompt_t p) {
  const uint8_t *start=NULL,*end=NULL;
  switch(p) { case CARELOOP_PROMPT_NOT_CONNECTED:start=not_connected;end=not_connected_end;break;case CARELOOP_PROMPT_NOT_SENT:start=not_sent;end=not_sent_end;break;case CARELOOP_PROMPT_RECEIPT_UNCONFIRMED:start=receipt_unconfirmed;end=receipt_unconfirmed_end;break;case CARELOOP_PROMPT_LOW_BATTERY:start=low_battery;end=low_battery_end;break;case CARELOOP_PROMPT_PROCESSING_FAILED:start=processing_failed;end=processing_failed_end;break;case CARELOOP_PROMPT_SAVED:start=saved;end=saved_end;break; }
  if(!start || !end || end-start < CARELOOP_WAV_HEADER_BYTES) return ESP_ERR_INVALID_SIZE;
  return careloop_play_wav_stream(b,start,start+CARELOOP_WAV_HEADER_BYTES,(size_t)(end-start-CARELOOP_WAV_HEADER_BYTES),exhausted,NULL);
}
