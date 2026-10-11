#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
typedef void *i2s_chan_handle_t;
typedef struct { bool auto_clear; } i2s_chan_config_t;
typedef struct { int rate; } i2s_std_clk_config_t;
typedef struct { int data_bit_width, slot_mode; } i2s_std_slot_config_t;
typedef struct { int mclk, bclk, ws, dout, din; } i2s_std_gpio_config_t;
typedef struct {
    i2s_std_clk_config_t clk_cfg;
    i2s_std_slot_config_t slot_cfg;
    i2s_std_gpio_config_t gpio_cfg;
} i2s_std_config_t;
#define I2S_NUM_1 1
#define I2S_ROLE_MASTER 1
#define I2S_DATA_BIT_WIDTH_32BIT 32
#define I2S_SLOT_MODE_STEREO 2
#define I2S_GPIO_UNUSED -1
#define I2S_CHANNEL_DEFAULT_CONFIG(id, role) {false}
#define I2S_STD_CLK_DEFAULT_CONFIG(rate) {rate}
#define I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(bits, mode) {bits, mode}
esp_err_t i2s_new_channel(const i2s_chan_config_t *, i2s_chan_handle_t *, i2s_chan_handle_t *);
esp_err_t i2s_channel_init_std_mode(i2s_chan_handle_t, const i2s_std_config_t *);
esp_err_t i2s_channel_enable(i2s_chan_handle_t);
esp_err_t i2s_channel_disable(i2s_chan_handle_t);
esp_err_t i2s_channel_write(i2s_chan_handle_t, const void *, size_t, size_t *, uint32_t);
