#include <math.h>
#include <stdio.h>
#include <string.h>
#include "driver/gpio.h"
#include "driver/i2s_std.h"
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "amplifier_bench";
static i2s_chan_handle_t tx;
static const unsigned sample_rate = 16000;
static const unsigned chunk_frames = 160;
static const int enable_gpio = CONFIG_PARSE_BENCH_ENABLE_GPIO;

#ifdef CONFIG_PARSE_BENCH_WIRING_CONFIRMED
static bool usable_output(int pin) {
    return pin >= 0 && GPIO_IS_VALID_OUTPUT_GPIO(pin) &&
           pin != 0 && pin != 3 && pin != 19 && pin != 20 &&
           (pin < 26 || pin > 37) && pin != 43 && pin != 44 && pin != 45;
}
#endif

static void amplifier_enable(bool enabled) {
    if (enable_gpio >= 0) gpio_set_level(enable_gpio, enabled ? 1 : 0);
}

static void report_memory(void) {
    esp_chip_info_t chip;
    esp_chip_info(&chip);
    uint32_t flash_bytes = 0;
    esp_err_t err = esp_flash_get_size(NULL, &flash_bytes);
    ESP_LOGI(TAG, "Chip revision=%u, cores=%u; flash=%lu bytes (%s)",
             chip.revision, chip.cores, (unsigned long)flash_bytes, esp_err_to_name(err));
    bool psram_ready = esp_psram_is_initialized();
    ESP_LOGI(TAG, "PSRAM initialized=%s, detected=%u bytes",
             psram_ready ? "yes" : "no", psram_ready ? (unsigned)esp_psram_get_size() : 0);
    const size_t bytes = 65536;
    uint8_t *memory = heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!memory) {
        ESP_LOGE(TAG, "64 KiB PSRAM allocation failed");
        return;
    }
    for (size_t i = 0; i < bytes; ++i) memory[i] = (uint8_t)(i ^ (i >> 8) ^ 0xa5);
    bool matched = true;
    for (size_t i = 0; i < bytes; ++i) {
        if (memory[i] != (uint8_t)(i ^ (i >> 8) ^ 0xa5)) { matched = false; break; }
    }
    heap_caps_free(memory);
    ESP_LOGI(TAG, "64 KiB PSRAM pattern check: %s", matched ? "PASS" : "FAIL");
}

static bool init_audio(void) {
#ifndef CONFIG_PARSE_BENCH_WIRING_CONFIRMED
    ESP_LOGW(TAG, "Audio disabled: physical module, power, speaker and wiring need confirmation");
    return false;
#else
    const int bclk = CONFIG_PARSE_BENCH_BCLK_GPIO;
    const int ws = CONFIG_PARSE_BENCH_WS_GPIO;
    const int data = CONFIG_PARSE_BENCH_DATA_GPIO;
    if (!usable_output(bclk) || !usable_output(ws) || !usable_output(data) ||
        (enable_gpio != -1 && !usable_output(enable_gpio)) ||
        bclk == ws || bclk == data || ws == data ||
        (enable_gpio >= 0 && (enable_gpio == bclk || enable_gpio == ws || enable_gpio == data))) {
        ESP_LOGE(TAG, "Audio disabled: missing, duplicate or reserved GPIO assignment");
        return false;
    }
    if (enable_gpio >= 0) {
        gpio_config_t enable = {.pin_bit_mask = 1ULL << enable_gpio, .mode = GPIO_MODE_OUTPUT};
        ESP_ERROR_CHECK(gpio_set_level(enable_gpio, 0));
        ESP_ERROR_CHECK(gpio_config(&enable));
    }
    i2s_chan_config_t channel = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    channel.auto_clear = true;
    ESP_ERROR_CHECK(i2s_new_channel(&channel, &tx, NULL));
    i2s_std_config_t config = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(sample_rate),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED, .bclk = bclk, .ws = ws,
            .dout = data, .din = I2S_GPIO_UNUSED,
        },
    };
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx, &config));
    ESP_LOGI(TAG, "Ready: BCLK=%d WS=%d DIN=%d SD=%d; 16 kHz, 16-bit stereo", bclk, ws, data, enable_gpio);
    ESP_LOGI(TAG, "Expected active clocks: WS=16 kHz, BCLK=512 kHz; both channels carry the same tone");
    return true;
#endif
}

static esp_err_t write_signal(unsigned frequency, unsigned milliseconds) {
    int16_t samples[320];
    const unsigned frames = sample_rate * milliseconds / 1000;
    for (unsigned start = 0; start < frames; start += chunk_frames) {
        unsigned count = frames - start;
        if (count > chunk_frames) count = chunk_frames;
        for (unsigned i = 0; i < count; ++i) {
            int16_t value = frequency ? (int16_t)(1000 * sinf(6.28318530718f * frequency * ((start + i) % sample_rate) / sample_rate)) : 0;
            samples[2 * i] = value;
            samples[2 * i + 1] = value;
        }
        size_t written = 0;
        size_t bytes = count * 2 * sizeof(int16_t);
        esp_err_t err = i2s_channel_write(tx, samples, bytes, &written, 250);
        if (err != ESP_OK) return err;
        if (written != bytes) return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}

static void tone_test(void) {
    if (!tx) { ESP_LOGW(TAG, "Tone unavailable until audio wiring is confirmed and configured"); return; }
    esp_err_t err = i2s_channel_enable(tx);
    if (err == ESP_OK) {
        err = write_signal(0, 40);
        if (err == ESP_OK) {
            amplifier_enable(true);
            ESP_LOGI(TAG, "TONE: 400 Hz for 500 ms, then 800 Hz for 500 ms; amplitude 1000/32767");
            err = write_signal(400, 500);
            if (err == ESP_OK) err = write_signal(800, 500);
            if (err == ESP_OK) err = write_signal(0, 120);
        }
        amplifier_enable(false);
        i2s_channel_disable(tx);
    }
    ESP_LOGI(TAG, "Tone write result: %s; amplifier returned to idle", esp_err_to_name(err));
}

void app_main(void) {
    report_memory();
    init_audio();
    ESP_LOGI(TAG, "Commands: t = one quiet two-tone test; m = memory report; s = idle. No automatic tones.");
    for (;;) {
        int command = getchar();
        if (command == 't') tone_test();
        else if (command == 'm') report_memory();
        else if (command == 's' && tx) amplifier_enable(false);
        if (command == EOF) clearerr(stdin);
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
