#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "careloop_wav.h"
#include "driver/gpio.h"
#include "driver/i2s_std.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/sha256.h"
#include "sdkconfig.h"

static const char *TAG = "microphone_bench";
static i2s_chan_handle_t rx;
enum { RATE = 16000, SECONDS = 6, FRAMES = RATE * SECONDS };
void network_probe(char *json);
#ifdef CONFIG_PARSE_MIC_BLE
void ble_bench_init(void);
void ble_bench_arm(void);
bool ble_bench_take_capture(void);
void ble_bench_capture_result(uint8_t *wav, size_t bytes);
void ble_bench_tick(void);
#endif

#ifdef CONFIG_PARSE_MIC_WIRING_CONFIRMED
static bool usable_pin(int pin) {
    return GPIO_IS_VALID_OUTPUT_GPIO(pin) && pin != 0 && pin != 3 &&
        pin != 19 && pin != 20 && (pin < 26 || pin > 37) &&
        pin != 43 && pin != 44 && pin != 45;
}
#endif

static void init_microphone(void) {
#ifndef CONFIG_PARSE_MIC_WIRING_CONFIRMED
    ESP_LOGW(TAG, "Microphone disabled pending physical wiring confirmation");
#else
    const int bclk = CONFIG_PARSE_MIC_BCLK_GPIO, ws = CONFIG_PARSE_MIC_WS_GPIO;
    const int data = CONFIG_PARSE_MIC_DATA_GPIO, amp = CONFIG_PARSE_MIC_AMP_ENABLE_GPIO;
    if (!usable_pin(bclk) || !usable_pin(ws) || !usable_pin(data) ||
        bclk == ws || bclk == data || ws == data ||
        (amp >= 0 && (!usable_pin(amp) || amp == bclk || amp == ws || amp == data))) {
        ESP_LOGE(TAG, "Invalid or conflicting microphone pin map");
        return;
    }
    if (amp >= 0) {
        ESP_ERROR_CHECK(gpio_set_level(amp, 0));
        ESP_ERROR_CHECK(gpio_set_direction(amp, GPIO_MODE_OUTPUT));
    }
    i2s_chan_config_t channel = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    ESP_ERROR_CHECK(i2s_new_channel(&channel, NULL, &rx));
    i2s_std_config_t standard = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(RATE),
        /* Two 32-bit slots guarantee the INMP441's required 64 clocks/frame. */
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = bclk, .ws = ws,
                     .dout = I2S_GPIO_UNUSED, .din = data},
    };
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(rx, &standard));
    ESP_LOGI(TAG, "INMP441 ready: SCK=%d WS=%d SD=%d L/R=GND (left), 16 kHz; idle", bclk, ws, data);
#endif
}

static uint8_t *capture(size_t *out_bytes, bool usb_output) {
    *out_bytes = 0;
    if (!rx) { puts("MIC_ERROR unavailable"); return NULL; }
    uint8_t *wav = heap_caps_malloc(44 + FRAMES * 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!wav) { puts("MIC_ERROR no_psram"); return NULL; }
    puts("MIC_COUNTDOWN 3"); fflush(stdout);
    vTaskDelay(pdMS_TO_TICKS(3000));
    esp_err_t err = i2s_channel_enable(rx);
    int32_t slots[256]; size_t got = 0;
    /* Discard startup samples for 200 ms, then record exactly six seconds. */
    for (unsigned warm = 0; err == ESP_OK && warm < 25; ++warm)
        err = i2s_channel_read(rx, slots, sizeof(slots), &got, 1000);
    puts("MIC_RECORDING 6"); fflush(stdout);
    size_t frames = 0;
    while (err == ESP_OK && frames < FRAMES) {
        err = i2s_channel_read(rx, slots, sizeof(slots), &got, 1000);
        if (err != ESP_OK || !got || got % 8) { if (err == ESP_OK) err = ESP_ERR_INVALID_SIZE; break; }
        for (size_t i = 0; i < got / sizeof(int32_t) && frames < FRAMES; i += 2) {
            int16_t sample = careloop_inmp441_to_pcm16(slots[i]);
            wav[44 + 2 * frames] = (uint8_t)sample;
            wav[45 + 2 * frames] = (uint8_t)(sample >> 8);
            ++frames;
        }
    }
    i2s_channel_disable(rx);
    if (err != ESP_OK || frames != FRAMES) {
        printf("MIC_ERROR %s frames=%u\n", esp_err_to_name(err), (unsigned)frames);
        free(wav); return NULL;
    }
    puts("MIC_STOPPED");
    careloop_wav_write_header(wav, frames * 2);
    for (unsigned second = 0; second < SECONDS; ++second) {
        double sum = 0, square = 0; unsigned peak = 0, nonzero = 0, clipped = 0;
        for (unsigned i = 0; i < RATE; ++i) {
            unsigned offset = 44 + 2 * (second * RATE + i);
            int16_t sample = (int16_t)((unsigned)wav[offset] | ((unsigned)wav[offset + 1] << 8));
            unsigned magnitude = abs((int)sample);
            sum += sample; square += (double)sample * sample;
            if (magnitude > peak) peak = magnitude;
            nonzero += sample != 0; clipped += magnitude >= 32767;
        }
        double mean = sum / RATE, variance = square / RATE - mean * mean;
        printf("MIC_LEVEL second=%u rms=%.2f peak=%u mean=%.2f nonzero=%u clipped=%u\n",
            second + 1, sqrt(fmax(0, variance)), peak, mean, nonzero, clipped);
    }
    unsigned char hash[32]; size_t bytes = 44 + frames * 2;
    if (mbedtls_sha256(wav, bytes, hash, 0) != 0) { puts("MIC_ERROR hash"); free(wav); return NULL; }
    *out_bytes = bytes;
    if (!usb_output) return wav;
    printf("MIC_WAV_BEGIN %u ", (unsigned)bytes);
    for (size_t i = 0; i < sizeof(hash); ++i) printf("%02x", hash[i]);
    putchar('\n');
    for (size_t offset = 0; offset < bytes; offset += 384) {
        size_t count = bytes - offset, length = 0; unsigned char encoded[513];
        if (count > 384) count = 384;
        if (mbedtls_base64_encode(encoded, sizeof(encoded), &length, wav + offset, count) != 0) {
            puts("MIC_ERROR encoding"); free(wav); *out_bytes = 0; return NULL;
        }
        printf("MIC_DATA %.*s\n", (int)length, encoded);
        /* UART polling can otherwise starve the idle task during a long WAV. */
        vTaskDelay(1);
    }
    puts("MIC_WAV_END"); fflush(stdout);
    return wav;
}

void app_main(void) {
    init_microphone();
#ifdef CONFIG_PARSE_MIC_BLE
    ble_bench_init();
    puts("PARSE_BENCH_READY commands: record; ble. No automatic capture or advertising.");
#else
    puts("PARSE_BENCH_READY commands: record; net <private JSON>. No automatic capture or Wi-Fi.");
#endif
    char line[512]; size_t length = 0; bool overflow = false;
    for (;;) {
#ifdef CONFIG_PARSE_MIC_BLE
        ble_bench_tick();
        if (ble_bench_take_capture()) {
            size_t bytes = 0;
            uint8_t *wav = capture(&bytes, false);
            ble_bench_capture_result(wav, bytes);
        }
#endif
        int ch = getchar();
        if (ch == EOF) { clearerr(stdin); vTaskDelay(pdMS_TO_TICKS(10)); continue; }
        if (ch == '\r') continue;
        if (ch == '\n') {
            line[length] = 0;
            if (overflow) puts("BENCH_ERROR command_too_long");
            else if (strcmp(line, "record") == 0) {
                size_t bytes = 0;
                free(capture(&bytes, true));
            }
#ifdef CONFIG_PARSE_MIC_BLE
            else if (strcmp(line, "ble") == 0) ble_bench_arm();
#else
            else if (strncmp(line, "net ", 4) == 0) network_probe(line + 4);
#endif
            else if (length) puts("BENCH_ERROR unknown_command");
            mbedtls_platform_zeroize(line, sizeof(line)); length = 0; overflow = false;
        } else if (length < sizeof(line) - 1 && !overflow) line[length++] = (char)ch;
        else overflow = true;
    }
}
