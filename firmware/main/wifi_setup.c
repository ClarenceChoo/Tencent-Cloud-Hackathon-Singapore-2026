#include "careloop_app.h"
#include "careloop_serial_line.h"
#include "driver/uart.h"
#include "driver/uart_vfs.h"
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "esp_timer.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_system.h"
#include "freertos/event_groups.h"

#define WIFI_CONNECTED_BIT BIT0
#if !CONFIG_CARELOOP_DIRECT_WIFI
#define SETUP_AP_TIMEOUT_MS (10U * 60U * 1000U)
#endif
static EventGroupHandle_t bits;
static careloop_app_t *current;
#if !CONFIG_CARELOOP_DIRECT_WIFI
static esp_timer_handle_t ap_timer;
#endif
#define WIFI_COMMAND_LINE_MAX CARELOOP_SERIAL_LINE_MAX
#define PARSE_BACKEND_URL "https://parse-phone-companion.iians0n.chatgpt.site"

static bool uuid_text(const char *s) {
  if (!s || strlen(s) != 36) return false;
  for (size_t i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (s[i] != '-') return false; }
    else if (!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f'))) return false;
  }
  return true;
}
static bool token_text(const char *s) {
  if (!s || strlen(s) != 64) return false;
  for (size_t i = 0; i < 64; i++) if (!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f'))) return false;
  return true;
}
static bool request_id_text(const char *s) {
  if (!s || strlen(s) > 64) return false;
  for (; *s; s++) if (!isalnum((unsigned char)*s) && *s != '-') return false;
  return true;
}
static void emit_status(careloop_app_t *app, const char *state, const char *code,
                        const char *message, const char *request_id, const char *error_code) {
  cJSON *root = cJSON_CreateObject(); if (!root) return;
  cJSON_AddNumberToObject(root, "protocol", 1);
  cJSON_AddStringToObject(root, "firmware", "parse-wifi-1");
  cJSON_AddStringToObject(root, "state", state ? state : "error");
  if (app) {
    cJSON_AddNumberToObject(root, "pttGpio", app->board.ptt);
    cJSON_AddBoolToObject(root, "talkPressed", careloop_ptt_pressed(&app->board));
    cJSON_AddBoolToObject(root, "wifiConnected", careloop_wifi_connected());
    wifi_ap_record_t access_point;
    if (careloop_wifi_connected() && esp_wifi_sta_get_ap_info(&access_point) == ESP_OK)
      cJSON_AddNumberToObject(root, "rssi", access_point.rssi);
  }
  if (app && app->settings.room_id[0]) cJSON_AddStringToObject(root, "roomId", app->settings.room_id);
  if (code && code[0]) cJSON_AddStringToObject(root, "code", code);
  if (message && message[0]) cJSON_AddStringToObject(root, "message", message);
  if (request_id && request_id_text(request_id)) cJSON_AddStringToObject(root, "requestId", request_id);
  if (error_code && error_code[0]) cJSON_AddStringToObject(root, "errorCode", error_code);
  char *json = cJSON_PrintUnformatted(root);
  if (json) { printf("PARSE_WIFI_STATUS %s\n", json); fflush(stdout); cJSON_free(json); }
  cJSON_Delete(root);
}
void careloop_wifi_status(careloop_app_t *app, const char *state, const char *code, const char *message) {
  if (!app) return;
  if (app->state_lock) xSemaphoreTake(app->state_lock, portMAX_DELAY);
  snprintf(app->wifi_state, sizeof(app->wifi_state), "%s", state ? state : "error");
  snprintf(app->wifi_code, sizeof(app->wifi_code), "%s", code ? code : "");
  snprintf(app->wifi_message, sizeof(app->wifi_message), "%s", message ? message : "");
  if (app->state_lock) xSemaphoreGive(app->state_lock);
  emit_status(app, app->wifi_state, app->wifi_code, app->wifi_message, NULL, NULL);
}
static bool copy_json_string(cJSON *root, const char *key, char *dest, size_t cap, bool optional) {
  cJSON *item = cJSON_GetObjectItemCaseSensitive(root, key);
  if (!item && optional) { dest[0] = 0; return true; }
  if (!cJSON_IsString(item) || !item->valuestring) return false;
  size_t n = strlen(item->valuestring);
  if (n >= cap) return false;
  memcpy(dest, item->valuestring, n + 1);
  return true;
}
static void setup_error(const char *request_id, const char *code, const char *message) {
  emit_status(current, "error", NULL, message, request_id, code);
}
static void new_device_token(char out[65]) {
  static const char hex[] = "0123456789abcdef"; uint8_t random[32]; esp_fill_random(random, sizeof(random));
  for (size_t i = 0; i < sizeof(random); i++) { out[i * 2] = hex[random[i] >> 4]; out[i * 2 + 1] = hex[random[i] & 15]; }
  out[64] = 0; memset(random, 0, sizeof(random));
}
static void process_wifi_command(char *line) {
  if (!current || !line || strlen(line) > WIFI_COMMAND_LINE_MAX) return;
  cJSON *root = cJSON_Parse(line); if (!cJSON_IsObject(root)) { if (root) cJSON_Delete(root); return; }
  char command[24] = {0}, request_id[65] = {0};
  copy_json_string(root, "command", command, sizeof(command), false);
  copy_json_string(root, "requestId", request_id, sizeof(request_id), true);
  if (!request_id_text(request_id)) request_id[0] = 0;
  if (!strcmp(command, "wifi_status")) {
    if (!current->wifi_state[0]) {
      const char *initial = current->settings.room_id[0] ? (careloop_wifi_connected() ? "connecting" : "offline") : "unconfigured";
      snprintf(current->wifi_state, sizeof(current->wifi_state), "%s", initial);
    }
    emit_status(current, current->wifi_state, current->wifi_code, current->wifi_message, request_id, NULL);
  } else if (!strcmp(command, "wifi_setup") || !strcmp(command, "wifi_network")) {
    char ssid[33] = {0}, password[65] = {0}, room_id[37] = {0}, pairing[65] = {0};
    const bool is_setup = !strcmp(command, "wifi_setup");
    bool valid = copy_json_string(root, "ssid", ssid, sizeof(ssid), false) &&
                 copy_json_string(root, "password", password, sizeof(password), false) &&
                 ssid[0] && (!password[0] || strlen(password) >= 8) &&
                 (is_setup ? (copy_json_string(root, "room_id", room_id, sizeof(room_id), false) &&
                              copy_json_string(root, "pairing_token", pairing, sizeof(pairing), false) &&
                              uuid_text(room_id) && token_text(pairing)) :
                             (uuid_text(current->settings.room_id) && token_text(current->settings.device_token)));
    if(careloop_direct_busy()) { setup_error(request_id,"device_busy","Wait for the active recording to finish before changing Wi-Fi settings."); }
    else if (!valid) { setup_error(request_id, "invalid_setup", is_setup ? "Check the Wi-Fi details and pairing invitation." : "Connect Parse before changing the Wi-Fi network."); }
    else {
      if(current->state_lock)xSemaphoreTake(current->state_lock,portMAX_DELAY);
      careloop_settings_t previous = current->settings;
      memcpy(current->settings.wifi_ssid, ssid, sizeof(ssid));
      memcpy(current->settings.wifi_password, password, sizeof(password));
      if (is_setup) {
        snprintf(current->settings.room_id, sizeof(current->settings.room_id), "%s", room_id);
        snprintf(current->settings.pairing_token, sizeof(current->settings.pairing_token), "%s", pairing);
        new_device_token(current->settings.device_token);
        snprintf(current->settings.backend_url, sizeof(current->settings.backend_url), "%s", PARSE_BACKEND_URL);
        memset(current->settings.relay_command_id, 0, sizeof(current->settings.relay_command_id));
        memset(current->settings.relay_claim_id, 0, sizeof(current->settings.relay_claim_id));
        memset(current->settings.relay_kind, 0, sizeof(current->settings.relay_kind));
        memset(current->settings.relay_receipt_state, 0, sizeof(current->settings.relay_receipt_state));
      }
      current->settings.configured = true;
      if (careloop_settings_save(&current->settings) != ESP_OK) { current->settings=previous;if(current->state_lock)xSemaphoreGive(current->state_lock); setup_error(request_id, "save_failed", "Could not save Wi-Fi settings."); }
      else {
        if(current->state_lock)xSemaphoreGive(current->state_lock);
        snprintf(current->wifi_state, sizeof(current->wifi_state), "connecting");
        snprintf(current->wifi_message, sizeof(current->wifi_message), "Settings saved. Connecting to the hotspot.");
        emit_status(current, "connecting", NULL, current->wifi_message, request_id, NULL);
        cJSON_Delete(root); vTaskDelay(pdMS_TO_TICKS(150)); esp_restart(); return;
      }
    }
    memset(ssid, 0, sizeof(ssid)); memset(password, 0, sizeof(password)); memset(pairing, 0, sizeof(pairing));
  } else if (!strcmp(command, "wifi_forget")) {
    cJSON *confirm = cJSON_GetObjectItemCaseSensitive(root, "confirm");
    if (!cJSON_IsTrue(confirm)) setup_error(request_id, "confirmation_required", "Confirm Wi-Fi removal to continue.");
    else {
      if(current->state_lock)xSemaphoreTake(current->state_lock,portMAX_DELAY);
      memset(current->settings.wifi_ssid, 0, sizeof(current->settings.wifi_ssid));
      memset(current->settings.wifi_password, 0, sizeof(current->settings.wifi_password));
      memset(current->settings.room_id, 0, sizeof(current->settings.room_id));
      memset(current->settings.pairing_token, 0, sizeof(current->settings.pairing_token));
      memset(current->settings.device_token, 0, sizeof(current->settings.device_token));
      memset(current->settings.relay_command_id, 0, sizeof(current->settings.relay_command_id));
      memset(current->settings.relay_claim_id, 0, sizeof(current->settings.relay_claim_id));
      memset(current->settings.relay_kind, 0, sizeof(current->settings.relay_kind));
      memset(current->settings.relay_receipt_state, 0, sizeof(current->settings.relay_receipt_state));
      memset(current->settings.backend_url, 0, sizeof(current->settings.backend_url));
      current->settings.configured = false;
      if (careloop_settings_save(&current->settings) != ESP_OK) {if(current->state_lock)xSemaphoreGive(current->state_lock);setup_error(request_id, "save_failed", "Could not remove the saved connection.");}
      else {if(current->state_lock)xSemaphoreGive(current->state_lock);emit_status(current, "unconfigured", NULL, "Saved Wi-Fi and Parse pairing removed.", request_id, NULL); cJSON_Delete(root); vTaskDelay(pdMS_TO_TICKS(150)); esp_restart(); return; }
    }
  } else setup_error(request_id, "unknown_command", "Use a supported Wi-Fi setup command.");
  cJSON_Delete(root);
}
void careloop_wifi_command_task(void *arg) {
  careloop_app_t *app = arg; current = app;
#if CONFIG_ESP_CONSOLE_UART
  const uart_port_t console_uart=(uart_port_t)CONFIG_ESP_CONSOLE_UART_NUM;
  if(!uart_is_driver_installed(console_uart))ESP_ERROR_CHECK(uart_driver_install(console_uart,2048,0,0,NULL,0));
  uart_vfs_dev_use_driver(console_uart);
#endif
  snprintf(app->wifi_state, sizeof(app->wifi_state), "%s", app->settings.room_id[0] ? "connecting" : "unconfigured");
  emit_status(app, app->wifi_state, NULL, NULL, NULL, NULL);
  careloop_serial_line_t input={0};
  for (;;) {
    careloop_serial_result_t result=careloop_serial_poll(stdin,&input);
    if(result==CARELOOP_SERIAL_READY)process_wifi_command(input.line);
    else if(result==CARELOOP_SERIAL_REJECTED)setup_error(NULL,"invalid_command_line","Setup command was too large or contained an invalid byte.");
    if(result==CARELOOP_SERIAL_READY||result==CARELOOP_SERIAL_REJECTED)memset(input.line,0,sizeof(input.line));
    if(result==CARELOOP_SERIAL_IDLE)vTaskDelay(pdMS_TO_TICKS(10));
  }
}

bool careloop_wifi_connected(void) { return bits && (xEventGroupGetBits(bits) & WIFI_CONNECTED_BIT); }
static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void)arg; (void)data;
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START && current && current->settings.configured) esp_wifi_connect();
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) { xEventGroupClearBits(bits, WIFI_CONNECTED_BIT); if (current && current->settings.configured) esp_wifi_connect(); }
  if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) xEventGroupSetBits(bits, WIFI_CONNECTED_BIT);
}
#if !CONFIG_CARELOOP_DIRECT_WIFI
static int decode(char *dst, size_t cap, const char *src) { size_t o=0; for (;*src && *src!='&';src++) { char c=*src; if (c=='+') c=' '; else if (c=='%' && isxdigit((unsigned char)src[1]) && isxdigit((unsigned char)src[2])) { char x[3]={src[1],src[2],0}; c=(char)strtol(x,NULL,16); src+=2; } if (o+1>=cap) return -1; dst[o++]=c; } dst[o]=0; return 0; }
static const char *value(const char *body, const char *key) { size_t n=strlen(key); for (const char *p=body; p && *p;) { if (!strncmp(p,key,n) && p[n]=='=') return p+n+1; p=strchr(p,'&'); if(p) ++p; } return NULL; }
static bool backend_base_valid(const char *u) { if(strncmp(u,"https://",8)||!u[8])return false; for(const char *p=u+8;*p;p++)if(*p=='/'||*p=='?'||*p=='#'||isspace((unsigned char)*p))return false; return true; }
static esp_err_t setup_get(httpd_req_t *r) { static const char page[] = "<!doctype html><meta name=viewport content='width=device-width'><title>CareLoop setup</title><form method=post action=/save>Wi-Fi name<br><input name=ssid maxlength=32 required><br>Wi-Fi password<br><input name=pass type=password maxlength=64><br>Service address (https only)<br><input name=backend maxlength=191 placeholder=https://care.example required><br><button>Connect</button></form>"; httpd_resp_set_type(r,"text/html"); return httpd_resp_send(r,page,HTTPD_RESP_USE_STRLEN); }
static esp_err_t setup_save(httpd_req_t *r) {
  if (r->content_len <= 0 || r->content_len > 512) { httpd_resp_send_err(r,HTTPD_400_BAD_REQUEST,"Invalid setup request"); return ESP_FAIL; }
  char body[513]; int n=httpd_req_recv(r,body,r->content_len); if(n<=0){ httpd_resp_send_err(r,HTTPD_408_REQ_TIMEOUT,"Incomplete request");return ESP_FAIL;} body[n]=0;
  const char *s=value(body,"ssid"),*p=value(body,"pass"),*b=value(body,"backend"); if(!s||!p||!b||decode(current->settings.wifi_ssid,sizeof(current->settings.wifi_ssid),s)||decode(current->settings.wifi_password,sizeof(current->settings.wifi_password),p)||decode(current->settings.backend_url,sizeof(current->settings.backend_url),b)||!backend_base_valid(current->settings.backend_url)){ httpd_resp_send_err(r,HTTPD_400_BAD_REQUEST,"Use a Wi-Fi network and https service hostname"); return ESP_FAIL; }
  current->settings.configured=true; if(careloop_settings_save(&current->settings)!=ESP_OK){httpd_resp_send_err(r,HTTPD_500_INTERNAL_SERVER_ERROR,"Could not save");return ESP_FAIL;} httpd_resp_sendstr(r,"Saved. CareLoop is connecting; this setup network will close."); vTaskDelay(pdMS_TO_TICKS(250)); esp_restart(); return ESP_OK;
}
static void ap_timeout(void *arg) { (void)arg; esp_wifi_stop(); /* Setup expires; a physical reset/reboot reopens it. */ }
static void start_ap(void) {
  wifi_config_t ap={0}; uint8_t mac[6]; esp_read_mac(mac,ESP_MAC_WIFI_SOFTAP); snprintf((char*)ap.ap.ssid,sizeof(ap.ap.ssid),"CareLoop-%02X%02X",mac[4],mac[5]); strncpy((char*)ap.ap.password,current->settings.setup_password,sizeof(ap.ap.password)-1); ap.ap.ssid_len=strlen((char*)ap.ap.ssid); ap.ap.max_connection=1; ap.ap.authmode=WIFI_AUTH_WPA2_PSK;
  esp_wifi_set_mode(WIFI_MODE_AP); esp_wifi_set_config(WIFI_IF_AP,&ap); esp_wifi_start();
  httpd_handle_t server=NULL; httpd_config_t cfg=HTTPD_DEFAULT_CONFIG(); cfg.lru_purge_enable=true; if(httpd_start(&server,&cfg)==ESP_OK){ httpd_uri_t get={.uri="/",.method=HTTP_GET,.handler=setup_get}, save={.uri="/save",.method=HTTP_POST,.handler=setup_save}; httpd_register_uri_handler(server,&get);httpd_register_uri_handler(server,&save); }
  const esp_timer_create_args_t t={.callback=ap_timeout,.name="setup_timeout"}; esp_timer_create(&t,&ap_timer); esp_timer_start_once(ap_timer,(uint64_t)SETUP_AP_TIMEOUT_MS*1000U);
}
#endif
esp_err_t careloop_wifi_start(careloop_app_t *app) {
  current=app; bits=xEventGroupCreate(); esp_netif_init(); esp_event_loop_create_default(); esp_netif_create_default_wifi_sta(); esp_netif_create_default_wifi_ap(); wifi_init_config_t init=WIFI_INIT_CONFIG_DEFAULT(); ESP_ERROR_CHECK(esp_wifi_init(&init)); ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT,ESP_EVENT_ANY_ID,wifi_event,NULL,NULL)); ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT,IP_EVENT_STA_GOT_IP,wifi_event,NULL,NULL));
  if(!app->settings.configured) {
    careloop_wifi_status(app, "unconfigured", NULL, "Use Parse USB setup to connect this device.");
#if CONFIG_CARELOOP_DIRECT_WIFI
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    return esp_wifi_start();
#else
    start_ap(); return ESP_OK;
#endif
  }
  if(app->settings.room_id[0]) careloop_wifi_status(app, "connecting", NULL, "Joining the saved hotspot.");
  wifi_config_t sta={0}; size_t ssid_len=strlen(app->settings.wifi_ssid),password_len=strlen(app->settings.wifi_password);
  if(ssid_len>sizeof(sta.sta.ssid)||password_len>sizeof(sta.sta.password))return ESP_ERR_INVALID_SIZE;
  if(password_len==sizeof(sta.sta.password))for(size_t i=0;i<password_len;i++)if(!isxdigit((unsigned char)app->settings.wifi_password[i]))return ESP_ERR_INVALID_ARG;
  memcpy(sta.sta.ssid,app->settings.wifi_ssid,ssid_len);memcpy(sta.sta.password,app->settings.wifi_password,password_len);
  sta.sta.threshold.authmode=password_len?WIFI_AUTH_WPA2_PSK:WIFI_AUTH_OPEN; ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA)); ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA,&sta)); return esp_wifi_start();
}
