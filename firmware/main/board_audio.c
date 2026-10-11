#include "careloop_app.h"
#include <stdlib.h>
#include <string.h>
#include "driver/gpio.h"
#include "driver/i2s.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/task.h"
#include "sdkconfig.h"
#include "careloop_wav.h"

#define AUDIO_DMA_COUNT 6
#define AUDIO_DMA_FRAMES 256
#define SPEAKER_FRAME_BYTES 2

/* WROOM-1 N16R8 exposes GPIO0..21 and GPIO35..48, but IO35..37 are
   physically connected to Octal PSRAM. GPIO26..34 are internal module pins. */
static bool pin_ok(int p) {
  if (!GPIO_IS_VALID_GPIO(p) || (p >= 26 && p <= 37)) return false;
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG || CONFIG_ESP_CONSOLE_SECONDARY_USB_SERIAL_JTAG
  if (p == 19 || p == 20) return false;
#endif
  return true;
}
static bool board_pins_valid(const careloop_board_t *b) {
  const int pins[] = {b->mic_bclk, b->mic_ws, b->mic_data, b->spk_bclk,
                     b->spk_ws, b->spk_data, b->amp_enable, b->ptt, b->haptic};
  for (size_t i = 0; i < sizeof(pins) / sizeof(pins[0]); i++) {
    if (pins[i] == -1) continue;
    if (!pin_ok(pins[i])) return false;
    if (i != 2 && i != 7 && !GPIO_IS_VALID_OUTPUT_GPIO(pins[i])) return false;
    for (size_t j = 0; j < i; j++) if (pins[j] == pins[i]) return false;
  }
  return true;
}
static void output(int p, bool active_high, bool on) { if (pin_ok(p)) gpio_set_level(p, (on == active_high) ? 1 : 0); }
static void playback_idle(const careloop_board_t *b) {
  careloop_amp(b, false);
  i2s_stop(I2S_NUM_1);
  i2s_zero_dma_buffer(I2S_NUM_1);
}
esp_err_t careloop_board_init(careloop_board_t *b) {
  *b = (careloop_board_t){CONFIG_CARELOOP_MIC_BCLK_GPIO, CONFIG_CARELOOP_MIC_WS_GPIO, CONFIG_CARELOOP_MIC_DATA_GPIO,
     CONFIG_CARELOOP_SPK_BCLK_GPIO, CONFIG_CARELOOP_SPK_WS_GPIO, CONFIG_CARELOOP_SPK_DATA_GPIO,
     CONFIG_CARELOOP_AMP_ENABLE_GPIO, CONFIG_CARELOOP_PTT_GPIO, CONFIG_CARELOOP_HAPTIC_GPIO};
  /* Reject conflicts before configuring any GPIO or installing I2S. */
  if (!board_pins_valid(b)) return ESP_ERR_INVALID_ARG;
  if (pin_ok(b->amp_enable)) { gpio_set_direction(b->amp_enable, GPIO_MODE_OUTPUT); output(b->amp_enable, CONFIG_CARELOOP_AMP_ENABLE_ACTIVE_HIGH, false); }
  if (pin_ok(b->haptic)) { gpio_set_direction(b->haptic, GPIO_MODE_OUTPUT); output(b->haptic, CONFIG_CARELOOP_HAPTIC_ACTIVE_HIGH, false); }
  if (pin_ok(b->ptt)) { gpio_set_direction(b->ptt, GPIO_MODE_INPUT); gpio_set_pull_mode(b->ptt, CONFIG_CARELOOP_PTT_ACTIVE_LOW ? GPIO_PULLUP_ONLY : GPIO_PULLDOWN_ONLY); }
  if (!careloop_board_microphone_ready(b) && !careloop_board_playback_ready(b)) return ESP_OK; /* Safe, intentionally inert pending pin map. */
  i2s_config_t rx = {.mode=I2S_MODE_MASTER|I2S_MODE_RX, .sample_rate=16000, .bits_per_sample=I2S_BITS_PER_SAMPLE_32BIT,
#if CONFIG_CARELOOP_DIRECT_WIFI
    .channel_format=I2S_CHANNEL_FMT_RIGHT_LEFT,
#else
    .channel_format=CONFIG_CARELOOP_MIC_LEFT_CHANNEL ? I2S_CHANNEL_FMT_ONLY_LEFT : I2S_CHANNEL_FMT_ONLY_RIGHT,
#endif
    .communication_format=I2S_COMM_FORMAT_STAND_I2S, .dma_buf_count=AUDIO_DMA_COUNT, .dma_buf_len=AUDIO_DMA_FRAMES, .use_apll=false};
  i2s_pin_config_t rpin = {.mck_io_num=I2S_PIN_NO_CHANGE,.bck_io_num=b->mic_bclk,.ws_io_num=b->mic_ws,.data_out_num=I2S_PIN_NO_CHANGE,.data_in_num=b->mic_data};
  i2s_config_t tx = {.mode=I2S_MODE_MASTER|I2S_MODE_TX, .sample_rate=16000, .bits_per_sample=I2S_BITS_PER_SAMPLE_16BIT, .channel_format=I2S_CHANNEL_FMT_ONLY_LEFT, .communication_format=I2S_COMM_FORMAT_STAND_I2S, .dma_buf_count=AUDIO_DMA_COUNT, .dma_buf_len=AUDIO_DMA_FRAMES, .use_apll=false, .tx_desc_auto_clear=true};
  i2s_pin_config_t tpin = {.mck_io_num=I2S_PIN_NO_CHANGE,.bck_io_num=b->spk_bclk,.ws_io_num=b->spk_ws,.data_out_num=b->spk_data,.data_in_num=I2S_PIN_NO_CHANGE};
  esp_err_t e = ESP_OK;
  if (careloop_board_microphone_ready(b)) { e = i2s_driver_install(I2S_NUM_0, &rx, 0, NULL); if (e == ESP_OK) { e = i2s_set_pin(I2S_NUM_0, &rpin); i2s_stop(I2S_NUM_0); } }
  if (e == ESP_OK && careloop_board_playback_ready(b)) { e = i2s_driver_install(I2S_NUM_1, &tx, 0, NULL); if (e == ESP_OK) { e = i2s_set_pin(I2S_NUM_1, &tpin); i2s_stop(I2S_NUM_1); i2s_zero_dma_buffer(I2S_NUM_1); } }
  return e;
}
bool careloop_board_microphone_ready(const careloop_board_t *b) { return pin_ok(b->mic_bclk)&&pin_ok(b->mic_ws)&&pin_ok(b->mic_data); }
bool careloop_board_playback_ready(const careloop_board_t *b) { return pin_ok(b->spk_bclk)&&pin_ok(b->spk_ws)&&pin_ok(b->spk_data); }
bool careloop_board_audio_ready(const careloop_board_t *b) { return careloop_board_microphone_ready(b)&&careloop_board_playback_ready(b); }
bool careloop_ptt_pressed(const careloop_board_t *b) { return pin_ok(b->ptt) && (gpio_get_level(b->ptt) == (CONFIG_CARELOOP_PTT_ACTIVE_LOW ? 0 : 1)); }
void careloop_haptic(const careloop_board_t *b, bool on) { output(b->haptic, CONFIG_CARELOOP_HAPTIC_ACTIVE_HIGH, on); }
void careloop_amp(const careloop_board_t *b, bool on) { output(b->amp_enable, CONFIG_CARELOOP_AMP_ENABLE_ACTIVE_HIGH, on); }
static esp_err_t capture_wav(const careloop_board_t *b, uint32_t duration_ms, bool wait_for_ptt, uint8_t **wav, size_t *wav_len) {
  if (!careloop_board_microphone_ready(b) || !wav || !wav_len || (wait_for_ptt && b->ptt < 0) || (!wait_for_ptt && (!duration_ms || duration_ms > 20000))) return ESP_ERR_INVALID_STATE;
  /* A full 20-second turn is 640,044 bytes. Do not consume ordinary application
     heap for it: the delivered board must provide and enable external PSRAM. */
  uint8_t *out = heap_caps_malloc(CARELOOP_MAX_WAV_BYTES, MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT); if (!out) return ESP_ERR_NO_MEM;
  careloop_amp(b, false); i2s_zero_dma_buffer(I2S_NUM_0);
  esp_err_t started=i2s_start(I2S_NUM_0); if(started!=ESP_OK){free(out);return started;}
  size_t pcm = 0; int32_t slots[128]; int64_t deadline = esp_timer_get_time() + (int64_t)(duration_ms ? duration_ms : 20000U)*1000LL;
#if CONFIG_CARELOOP_DIRECT_WIFI
  {
    const size_t warm_frames=(size_t)16000U*200U/1000U;
    const size_t target_frames=(size_t)duration_ms*16000U/1000U;
    size_t discarded=0,frames=0;
    while(esp_timer_get_time()<deadline+2000000LL && (discarded<warm_frames || frames<target_frames)){
      if(wait_for_ptt && !careloop_ptt_pressed(b)) break;
      size_t got=0;esp_err_t e=i2s_read(I2S_NUM_0,slots,sizeof(slots),&got,pdMS_TO_TICKS(100));
      if(e!=ESP_OK){i2s_stop(I2S_NUM_0);free(out);return e;}
      if(!got||got%8){i2s_stop(I2S_NUM_0);free(out);return ESP_ERR_INVALID_SIZE;}
      for(size_t i=0;i<got/sizeof(int32_t);i+=2){
        if(discarded<warm_frames){discarded++;continue;}
        if(frames>=target_frames)break;
        int16_t sample=careloop_inmp441_to_pcm16(slots[i]);
        out[44+pcm++]=(uint8_t)sample;out[44+pcm++]=(uint8_t)(sample>>8);frames++;
      }
    }
    i2s_stop(I2S_NUM_0);
    if(!wait_for_ptt && (discarded!=warm_frames||frames!=target_frames)){free(out);return ESP_ERR_TIMEOUT;}
    if(pcm<CARELOOP_MIN_PCM_BYTES){free(out);return ESP_ERR_INVALID_SIZE;}
    careloop_wav_write_header(out,(uint32_t)pcm);*wav=out;*wav_len=44+pcm;return ESP_OK;
  }
#endif
  while ((!wait_for_ptt || careloop_ptt_pressed(b)) && esp_timer_get_time() < deadline && pcm + sizeof(slots)/2 <= CARELOOP_MAX_PCM_BYTES) {
    size_t got = 0; esp_err_t e = i2s_read(I2S_NUM_0, slots, sizeof(slots), &got, pdMS_TO_TICKS(100)); if (e != ESP_OK) { i2s_stop(I2S_NUM_0); free(out); return e; }
    for (size_t i=0;i<got/sizeof(int32_t);i++) { int16_t s = careloop_inmp441_to_pcm16(slots[i]); out[44+pcm++] = (uint8_t)s; out[44+pcm++] = (uint8_t)(s>>8); }
  }
  i2s_stop(I2S_NUM_0);
  careloop_wav_write_header(out, pcm); if (pcm < CARELOOP_MIN_PCM_BYTES) { free(out); return ESP_ERR_INVALID_SIZE; } *wav=out; *wav_len=44+pcm; return ESP_OK;
}
esp_err_t careloop_capture_wav(const careloop_board_t *b, uint8_t **wav, size_t *wav_len) { return capture_wav(b,20000,true,wav,wav_len); }
esp_err_t careloop_capture_wav_timed(const careloop_board_t *b,uint32_t duration_ms,uint8_t **wav,size_t *wav_len) { return capture_wav(b,duration_ms,false,wav,wav_len); }
esp_err_t careloop_play_wav_stream(const careloop_board_t *b, const uint8_t *header, const uint8_t *first, size_t first_len, int (*next)(void*,uint8_t*,size_t), void *ctx) {
  uint32_t bytes; if (!careloop_board_playback_ready(b) || !careloop_wav_header_valid(header, &bytes) || bytes < CARELOOP_MIN_PCM_BYTES) return ESP_ERR_INVALID_ARG;
  i2s_stop(I2S_NUM_1); i2s_zero_dma_buffer(I2S_NUM_1);
  if(i2s_start(I2S_NUM_1)!=ESP_OK) { playback_idle(b); return ESP_FAIL; }
  careloop_amp(b, true); size_t played=0, n=first_len; uint8_t buf[1024]; const uint8_t *source=first;
  while (played < bytes) { if (n == 0) { int r=next(ctx,buf,sizeof(buf)); if (r <= 0) { playback_idle(b); return ESP_FAIL; } source=buf; n=(size_t)r; }
    size_t take=n; if (take > bytes-played) take=bytes-played; size_t wrote=0; if (i2s_write(I2S_NUM_1, source, take, &wrote, pdMS_TO_TICKS(250)) != ESP_OK || wrote != take) { playback_idle(b); return ESP_FAIL; }
    played += take; source += take; n -= take; if (careloop_ptt_pressed(b)) { playback_idle(b); return ESP_ERR_INVALID_STATE; }
  }
  /* Legacy i2s_write queues DMA bytes; it does not wait for their transmission.
     More than one complete ring of silence forces the final PCM past the DMA
     consumer, including a partially filled final descriptor. */
  const uint8_t silence[AUDIO_DMA_FRAMES * SPEAKER_FRAME_BYTES] = {0};
  for (unsigned i = 0; i <= AUDIO_DMA_COUNT; i++) {
    if (careloop_ptt_pressed(b)) { playback_idle(b); return ESP_ERR_INVALID_STATE; }
    size_t wrote = 0;
    if (i2s_write(I2S_NUM_1, silence, sizeof(silence), &wrote, pdMS_TO_TICKS(250)) != ESP_OK ||
        wrote != sizeof(silence)) { playback_idle(b); return ESP_FAIL; }
    if (careloop_ptt_pressed(b)) { playback_idle(b); return ESP_ERR_INVALID_STATE; }
  }
  playback_idle(b);
  return ESP_OK;
}
