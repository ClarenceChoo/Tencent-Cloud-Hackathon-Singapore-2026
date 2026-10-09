#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "mbedtls/platform_util.h"
#include "nvs_flash.h"

static EventGroupHandle_t events;
static bool initialized;
static void event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) esp_wifi_connect();
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) xEventGroupSetBits(events, BIT1);
    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) xEventGroupSetBits(events, BIT0);
}

static void probe_url(const char *label, const char *url) {
    esp_http_client_config_t config = {.url = url, .method = HTTP_METHOD_GET,
        .crt_bundle_attach = esp_crt_bundle_attach, .timeout_ms = 12000,
        .disable_auto_redirect = true, .buffer_size = 1024};
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) { printf("NET_HTTP %s error=allocation\n", label); return; }
    esp_err_t err = esp_http_client_open(client, 0);
    if (err == ESP_OK && esp_http_client_fetch_headers(client) < 0) err = ESP_FAIL;
    printf("NET_HTTP %s result=%s status=%d tls_verified=%s\n", label,
        esp_err_to_name(err), esp_http_client_get_status_code(client), err == ESP_OK ? "yes" : "no");
    esp_http_client_close(client); esp_http_client_cleanup(client);
}

void network_probe(char *json) {
    cJSON *root = cJSON_Parse(json);
    const cJSON *ssid = cJSON_GetObjectItemCaseSensitive(root, "ssid");
    const cJSON *password = cJSON_GetObjectItemCaseSensitive(root, "password");
    const cJSON *epoch = cJSON_GetObjectItemCaseSensitive(root, "epoch");
    bool valid = cJSON_IsString(ssid) && cJSON_IsString(password) && cJSON_IsNumber(epoch) &&
        strlen(ssid->valuestring) > 0 && strlen(ssid->valuestring) <= 32 &&
        strlen(password->valuestring) >= 8 && strlen(password->valuestring) <= 63 &&
        epoch->valuedouble > 1700000000 && epoch->valuedouble < 2200000000;
    wifi_config_t config = {0};
    if (valid) {
        memcpy(config.sta.ssid, ssid->valuestring, strlen(ssid->valuestring));
        memcpy(config.sta.password, password->valuestring, strlen(password->valuestring));
        config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
        struct timeval now = {.tv_sec = (time_t)epoch->valuedouble};
        settimeofday(&now, NULL);
    }
    if (cJSON_IsString(password)) mbedtls_platform_zeroize(password->valuestring, strlen(password->valuestring));
    cJSON_Delete(root);
    mbedtls_platform_zeroize(json, strlen(json));
    if (!valid) { puts("NET_ERROR provide_wpa2_ssid_password_and_current_epoch"); return; }
    esp_err_t err = ESP_OK;
    if (!initialized) {
        err = nvs_flash_init(); /* Preserve existing NVS: never erase on failure. */
        if (err == ESP_OK) err = esp_netif_init();
        if (err == ESP_OK) err = esp_event_loop_create_default();
        if (err == ESP_OK) {
            events = xEventGroupCreate();
            if (!events || !esp_netif_create_default_wifi_sta()) err = ESP_ERR_NO_MEM;
        }
        if (err == ESP_OK) err = esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, event, NULL);
        if (err == ESP_OK) err = esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, event, NULL);
        if (err == ESP_OK) initialized = true;
    }
    esp_log_level_set("wifi", ESP_LOG_WARN);
    wifi_init_config_t defaults = WIFI_INIT_CONFIG_DEFAULT();
    bool wifi_ready = false;
    if (err == ESP_OK) { err = esp_wifi_init(&defaults); wifi_ready = err == ESP_OK; }
    if (err == ESP_OK) err = esp_wifi_set_storage(WIFI_STORAGE_RAM);
    if (err == ESP_OK) err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err == ESP_OK) err = esp_wifi_set_config(WIFI_IF_STA, &config);
    mbedtls_platform_zeroize(&config, sizeof(config));
    if (err == ESP_OK) {
        xEventGroupClearBits(events, BIT0 | BIT1);
        err = esp_wifi_start();
    }
    if (err == ESP_OK) {
        EventBits_t result = xEventGroupWaitBits(events, BIT0 | BIT1, pdTRUE, pdFALSE, pdMS_TO_TICKS(20000));
        if (result & BIT0) {
            puts("NET_WIFI connected");
            probe_url("public_phone", "https://parse-phone-companion.iians0n.chatgpt.site/phone");
            probe_url("private_device_api", "https://parse-shared-voice.iians0n.chatgpt.site/v1/device/info");
        } else puts("NET_WIFI failed_or_timed_out");
    } else printf("NET_ERROR %s\n", esp_err_to_name(err));
    if (wifi_ready) { esp_wifi_stop(); esp_wifi_deinit(); }
    puts("NET_DONE disconnected; credentials were not saved"); fflush(stdout);
}
