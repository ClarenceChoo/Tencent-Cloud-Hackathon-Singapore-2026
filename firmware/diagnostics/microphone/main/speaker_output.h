#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

void speaker_output_init(void);
bool speaker_output_available(void);
esp_err_t speaker_output_play(const uint8_t *wav, size_t bytes, bool (*allowed)(void));
