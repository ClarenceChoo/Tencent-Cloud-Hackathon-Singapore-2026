#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#define CONFIG_PARSE_MIC_SPEAKER_ENABLED 1
#define CONFIG_PARSE_MIC_BCLK_GPIO 4
#define CONFIG_PARSE_MIC_WS_GPIO 5
#define CONFIG_PARSE_MIC_DATA_GPIO 6
#define CONFIG_PARSE_MIC_SPK_BCLK_GPIO 7
#define CONFIG_PARSE_MIC_SPK_WS_GPIO 15
#define CONFIG_PARSE_MIC_SPK_DATA_GPIO 16
#define CONFIG_PARSE_MIC_AMP_ENABLE_GPIO -1
#define ESP_ERROR_CHECK(expr) assert((expr) == ESP_OK)
#define ESP_ERR_NOT_SUPPORTED -6
#define ESP_LOGI(tag, ...) ((void)(tag), (void)printf(__VA_ARGS__))
#define ESP_LOGE(tag, ...) ((void)(tag), (void)printf(__VA_ARGS__))
#include "../diagnostics/microphone/main/speaker_output.c"

static int32_t output[20000];
static size_t output_words;
static bool enabled, partial, fail_write;
static unsigned writes;
static uint8_t wav[44 + 9600];
const char *esp_err_to_name(int err) { return err ? "ERROR" : "OK"; }
int64_t esp_timer_get_time(void) { return 0; }
esp_err_t i2s_new_channel(const i2s_chan_config_t *cfg, i2s_chan_handle_t *out, i2s_chan_handle_t *in) {
    (void)cfg; (void)in; *out = (void *)1; return ESP_OK;
}
esp_err_t i2s_channel_init_std_mode(i2s_chan_handle_t chan, const i2s_std_config_t *cfg) {
    (void)chan;
    assert(cfg->clk_cfg.rate == 16000 && cfg->slot_cfg.data_bit_width == 32);
    assert(cfg->slot_cfg.slot_mode == 2);
    assert(cfg->gpio_cfg.bclk == 7 && cfg->gpio_cfg.ws == 15 && cfg->gpio_cfg.dout == 16);
    return ESP_OK;
}
esp_err_t i2s_channel_enable(i2s_chan_handle_t chan) { (void)chan; enabled = true; return ESP_OK; }
esp_err_t i2s_channel_disable(i2s_chan_handle_t chan) { (void)chan; enabled = false; return ESP_OK; }
esp_err_t i2s_channel_write(i2s_chan_handle_t chan, const void *src, size_t bytes, size_t *done, uint32_t timeout) {
    (void)chan; assert(enabled && bytes % 8 == 0 && timeout == 250); writes++;
    if (fail_write) return ESP_ERR_TIMEOUT;
    *done = partial ? bytes - 8 : bytes;
    assert(output_words + *done / 4 <= sizeof(output) / sizeof(*output));
    memcpy(output + output_words, src, *done); output_words += *done / 4;
    return ESP_OK;
}
static bool active(void) { return true; }
static bool expires(void) { return writes < 9; }
static int source_sample(unsigned i) { return ((int)(i % 61) - 30) * 100; }

int main(int argc, char **argv) {
    assert(argc == 2);
    careloop_wav_write_header(wav, 9600);
    for (unsigned i = 0; i < 4800; i++) {
        int16_t sample = source_sample(i);
        wav[44 + i * 2] = (uint8_t)sample;
        wav[45 + i * 2] = (uint8_t)((uint16_t)sample >> 8);
    }
    speaker_output_init();
    assert(speaker_output_available());
    if (!strcmp(argv[1], "pcm32_mapping")) {
        assert(speaker_output_play(wav, sizeof(wav), active) == ESP_OK);
        assert(output_words == (640 + 4800 + 1920) * 2);
        for (unsigned frame = 0; frame < output_words / 2; frame++) {
            int32_t expected = frame >= 640 && frame < 5440 ? source_sample(frame - 640) * 65536 : 0;
            assert(output[frame * 2] == expected && output[frame * 2 + 1] == expected);
        }
    } else if (!strcmp(argv[1], "peak_limit")) {
        wav[44] = 0; wav[45] = 0x80; /* INT16_MIN must not overflow abs or scaling. */
        assert(speaker_output_play(wav, sizeof(wav), active) == ESP_OK);
        assert(output[640 * 2] == -8000 * 65536);
        for (size_t i = 0; i < output_words; i++) assert(llabs(output[i]) <= 8000LL * 65536);
    } else if (!strcmp(argv[1], "partial_write")) {
        partial = true;
        assert(speaker_output_play(wav, sizeof(wav), active) == ESP_ERR_INVALID_SIZE);
    } else if (!strcmp(argv[1], "driver_error")) {
        fail_write = true;
        assert(speaker_output_play(wav, sizeof(wav), active) == ESP_ERR_TIMEOUT);
    } else if (!strcmp(argv[1], "session_expiry")) {
        assert(speaker_output_play(wav, sizeof(wav), expires) == ESP_ERR_INVALID_STATE);
        assert(writes == 9);
    } else if (!strcmp(argv[1], "invalid_wav")) {
        wav[24] = 0;
        assert(speaker_output_play(wav, sizeof(wav), active) == ESP_ERR_INVALID_ARG);
        assert(writes == 0);
    } else { assert(!"unknown test"); }
    assert(!enabled);
    return 0;
}
