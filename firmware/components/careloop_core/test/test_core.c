#include <assert.h>
#include <string.h>
#include "careloop_protocol.h"
#include "careloop_state.h"
#include "careloop_wav.h"
int main(void) {
  uint8_t wav[CARELOOP_WAV_HEADER_BYTES + CARELOOP_MIN_PCM_BYTES]; uint32_t pcm = 0;
  careloop_wav_write_header(wav, CARELOOP_MIN_PCM_BYTES);
  assert(careloop_wav_validate(wav, sizeof(wav), &pcm) == CARELOOP_WAV_OK && pcm == CARELOOP_MIN_PCM_BYTES);
  assert(careloop_inmp441_to_pcm16(0x7fffff00) == 32767 && careloop_inmp441_to_pcm16((int32_t)0x80000000) == -32768);
  assert(careloop_relative_audio_path_valid("/v1/device/audio/a") && !careloop_relative_audio_path_valid("https://bad"));
  const char *clips[] = {"/v1/device/audio/first", "/v1/device/audio/second"};
  const char *invalid[] = {"/v1/device/audio/first", "/v1/device/audio/../../bad"};
  assert(careloop_audio_path_list_valid(clips, 2) && !careloop_audio_path_list_valid(invalid, 2));
  assert(!careloop_audio_path_list_valid(clips, 0) && !careloop_audio_path_list_valid(clips, CARELOOP_REPLY_CLIPS_MAX + 1));
  const char *selected[CARELOOP_REPLY_CLIPS_MAX];
  assert(careloop_reply_path_select(clips, 2, "/v1/device/audio/legacy", selected) == 2 && !strcmp(selected[1], clips[1]));
  assert(careloop_reply_path_select(NULL, 0, "/v1/device/audio/legacy", selected) == 1 && !strcmp(selected[0], "/v1/device/audio/legacy"));
  assert(careloop_reply_path_select(invalid, 2, "/v1/device/audio/legacy", selected) == 0);
  assert(careloop_command_is_playable(100, 101, true, 2, 2) && !careloop_command_is_playable(100, 99, true, 2, 2));
  assert(careloop_retry_delay_ms(2, 10) == 4010 && careloop_retry_is_transient(503) && !careloop_retry_is_transient(401));
  careloop_machine_t m; careloop_state_init(&m, 0); assert(careloop_state_apply(&m, CARELOOP_EV_WIFI_UP, 1));
  assert(m.state == CARELOOP_IDLE && careloop_state_apply(&m, CARELOOP_EV_PRESS, 2));
  assert(!careloop_state_mic_enabled(m.state) && careloop_state_apply(&m, CARELOOP_EV_CUE_DONE, 3)); assert(careloop_state_mic_enabled(m.state));
  return 0;
}
