#pragma once
#include <stddef.h>
#include <stdbool.h>
#define I2S_NUM_0 0
#define I2S_NUM_1 1
#define I2S_MODE_MASTER 1
#define I2S_MODE_RX 2
#define I2S_MODE_TX 4
#define I2S_BITS_PER_SAMPLE_32BIT 32
#define I2S_BITS_PER_SAMPLE_16BIT 16
#define I2S_CHANNEL_FMT_ONLY_LEFT 1
#define I2S_CHANNEL_FMT_ONLY_RIGHT 2
#define I2S_CHANNEL_FMT_RIGHT_LEFT 3
#define I2S_COMM_FORMAT_STAND_I2S 1
#define I2S_PIN_NO_CHANGE -1
typedef struct { int mode,sample_rate,bits_per_sample,channel_format,communication_format,dma_buf_count,dma_buf_len; bool use_apll,tx_desc_auto_clear; } i2s_config_t;
typedef struct { int mck_io_num,bck_io_num,ws_io_num,data_out_num,data_in_num; } i2s_pin_config_t;
int i2s_driver_install(int,const i2s_config_t*,int,void*);
int i2s_set_pin(int,const i2s_pin_config_t*);
int i2s_stop(int); int i2s_start(int); int i2s_zero_dma_buffer(int);
int i2s_read(int,void*,size_t,size_t*,unsigned);
int i2s_write(int,const void*,size_t,size_t*,unsigned);
