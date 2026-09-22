#include "careloop_app.h"
#include <string.h>
#include "esp_random.h"
#include "nvs.h"
#include "nvs_flash.h"

static esp_err_t open(nvs_handle_t *h) { return nvs_open("careloop", NVS_READWRITE, h); }
static void getstr(nvs_handle_t h, const char *key, char *dst, size_t cap) { size_t n = cap; if (nvs_get_str(h, key, dst, &n) != ESP_OK) dst[0] = 0; }
static void setup_password(char out[17]) { static const char hex[] = "0123456789ABCDEF"; for (int i=0;i<16;i++) out[i] = hex[esp_random() & 15U]; out[16] = 0; }

esp_err_t careloop_settings_load(careloop_settings_t *s, careloop_ledger_t *ledger) {
    memset(s, 0, sizeof(*s)); memset(ledger, 0, sizeof(*ledger));
    esp_err_t e = nvs_flash_init();
    if (e == ESP_ERR_NVS_NO_FREE_PAGES || e == ESP_ERR_NVS_NEW_VERSION_FOUND) { nvs_flash_erase(); e = nvs_flash_init(); }
    if (e != ESP_OK) return e;
    nvs_handle_t h;
    if ((e = open(&h)) != ESP_OK) return e;
    getstr(h, "ssid", s->wifi_ssid, sizeof(s->wifi_ssid)); getstr(h, "pass", s->wifi_password, sizeof(s->wifi_password));
    getstr(h, "backend", s->backend_url, sizeof(s->backend_url)); getstr(h, "token", s->device_token, sizeof(s->device_token));
    getstr(h, "setup_pw", s->setup_password, sizeof(s->setup_password));
    if (!s->setup_password[0]) { setup_password(s->setup_password); nvs_set_str(h, "setup_pw", s->setup_password); nvs_commit(h); }
    size_t bytes = sizeof(*ledger); if (nvs_get_blob(h, "ledger", ledger, &bytes) != ESP_OK || bytes != sizeof(*ledger)) memset(ledger, 0, sizeof(*ledger));
    nvs_close(h); s->configured = s->wifi_ssid[0] && s->backend_url[0]; return ESP_OK;
}
esp_err_t careloop_settings_save(const careloop_settings_t *s) {
    nvs_handle_t h; esp_err_t e = open(&h); if (e != ESP_OK) return e;
    e = nvs_set_str(h, "ssid", s->wifi_ssid); if (e == ESP_OK) e = nvs_set_str(h, "pass", s->wifi_password);
    if (e == ESP_OK) e = nvs_set_str(h, "backend", s->backend_url);
    if (e == ESP_OK) e = nvs_set_str(h, "token", s->device_token);
    if (e == ESP_OK) e = nvs_set_str(h, "setup_pw", s->setup_password);
    if (e == ESP_OK) e = nvs_commit(h);
    nvs_close(h);
    return e;
}
esp_err_t careloop_ledger_save(const careloop_ledger_t *l) { nvs_handle_t h; esp_err_t e = open(&h); if (e == ESP_OK) { e = nvs_set_blob(h, "ledger", l, sizeof(*l)); if (e == ESP_OK) e = nvs_commit(h); nvs_close(h); } return e; }
