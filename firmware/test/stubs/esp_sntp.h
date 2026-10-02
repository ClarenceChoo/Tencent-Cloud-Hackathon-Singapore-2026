#pragma once
#define SNTP_OPMODE_POLL 0
void esp_sntp_setoperatingmode(int);
void esp_sntp_setservername(int,const char*);
void esp_sntp_init(void);
