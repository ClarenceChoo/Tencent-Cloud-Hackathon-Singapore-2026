#include "speaker_output.h"
#include "careloop_wav.h"
#include "driver/gpio.h"
#include "driver/i2s_std.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "sdkconfig.h"

static i2s_chan_handle_t tx;
enum { RATE = 16000, CHUNK = 160, PEAK_LIMIT = 8000 };

#ifdef CONFIG_PARSE_MIC_SPEAKER_ENABLED
static bool usable(int pin) {
    return pin >= 0 && GPIO_IS_VALID_OUTPUT_GPIO(pin) && pin != 0 && pin != 3 &&
        pin != 19 && pin != 20 && (pin < 26 || pin > 37) &&
        pin != 43 && pin != 44 && pin != 45 &&
        pin != CONFIG_PARSE_MIC_BCLK_GPIO && pin != CONFIG_PARSE_MIC_WS_GPIO &&
        pin != CONFIG_PARSE_MIC_DATA_GPIO;
}
#endif

void speaker_output_init(void) {
#ifdef CONFIG_PARSE_MIC_SPEAKER_ENABLED
    const int bclk = CONFIG_PARSE_MIC_SPK_BCLK_GPIO;
    const int ws = CONFIG_PARSE_MIC_SPK_WS_GPIO;
    const int data = CONFIG_PARSE_MIC_SPK_DATA_GPIO;
    /* This profile is specifically for SD/EN tied to 3V3 in the handover. */
    if (!usable(bclk) || !usable(ws) || !usable(data) || bclk == ws ||
        bclk == data || ws == data || CONFIG_PARSE_MIC_AMP_ENABLE_GPIO != -1) {
        ESP_LOGE("speaker_bench", "Invalid handover speaker wiring configuration");
        return;
    }
    i2s_chan_config_t channel = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    channel.auto_clear = true;
    ESP_ERROR_CHECK(i2s_new_channel(&channel, &tx, NULL));
    i2s_std_config_t standard = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = bclk, .ws = ws,
                     .dout = data, .din = I2S_GPIO_UNUSED},
    };
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx, &standard));
    ESP_LOGI("speaker_bench", "MAX98357A ready: BCLK=%d WS=%d DIN=%d SD=3V3; 32-bit slots; idle", bclk, ws, data);
#endif
}

bool speaker_output_available(void) { return tx != NULL; }

static esp_err_t write_frames(const int32_t *samples, size_t frames) {
    size_t written = 0, bytes = frames * 2 * sizeof(int32_t);
    esp_err_t err = i2s_channel_write(tx, samples, bytes, &written, 250);
    return err != ESP_OK ? err : written == bytes ? ESP_OK : ESP_ERR_INVALID_SIZE;
}

static esp_err_t silence(unsigned frames, bool (*allowed)(void)) {
    const int32_t zero[CHUNK * 2] = {0};
    while (frames) {
        if (allowed && !allowed()) return ESP_ERR_INVALID_STATE;
        unsigned count = frames > CHUNK ? CHUNK : frames;
        esp_err_t err = write_frames(zero, count);
        if (err != ESP_OK) return err;
        frames -= count;
    }
    return ESP_OK;
}

esp_err_t speaker_output_play(const uint8_t *wav, size_t bytes, bool (*allowed)(void)) {
    uint32_t pcm = 0;
    if (!tx) return ESP_ERR_NOT_SUPPORTED;
    if (careloop_wav_validate(wav, bytes, &pcm) != CARELOOP_WAV_OK) return ESP_ERR_INVALID_ARG;
    const uint8_t *data = wav + CARELOOP_WAV_HEADER_BYTES;
    int peak = 1;
    for (size_t i = 0; i < pcm; i += 2) {
        int value = (int16_t)((unsigned)data[i] | ((unsigned)data[i + 1] << 8));
        int magnitude = value < 0 ? -value : value;
        if (magnitude > peak) peak = magnitude;
    }
    int64_t started = esp_timer_get_time();
    esp_err_t err = i2s_channel_enable(tx);
    if (err != ESP_OK) return err;
    err = silence(RATE * 40 / 1000, allowed);
    int32_t stereo[CHUNK * 2];
    for (size_t frame = 0; err == ESP_OK && frame < pcm / 2;) {
        if (allowed && !allowed()) { err = ESP_ERR_INVALID_STATE; break; }
        size_t count = pcm / 2 - frame;
        if (count > CHUNK) count = CHUNK;
        for (size_t i = 0; i < count; ++i) {
            size_t offset = (frame + i) * 2;
            int value = (int16_t)((unsigned)data[offset] | ((unsigned)data[offset + 1] << 8));
            if (peak > PEAK_LIMIT) value = value * PEAK_LIMIT / peak;
            /* Place signed PCM16 in the upper half of each 32-bit slot.
             * Multiplication avoids undefined left shifts of negative values. */
            stereo[i * 2] = stereo[i * 2 + 1] = (int32_t)value * 65536;
        }
        err = write_frames(stereo, count);
        frame += count;
    }
    /* More than the default 90 ms DMA ring, so the final speech drains. */
    if (err == ESP_OK) err = silence(RATE * 120 / 1000, allowed);
    esp_err_t stopped = i2s_channel_disable(tx);
    if (err == ESP_OK) err = stopped;
    ESP_LOGI("speaker_bench", "Playback pcm_bytes=%u elapsed_ms=%lld peak=%d result=%s",
             (unsigned)pcm, (long long)((esp_timer_get_time() - started) / 1000), peak, esp_err_to_name(err));
    return err;
}
