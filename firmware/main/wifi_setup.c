#include "careloop_app.h"
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "esp_timer.h"
#include "esp_mac.h"
#include "freertos/event_groups.h"

#define WIFI_CONNECTED_BIT BIT0
#define SETUP_AP_TIMEOUT_MS (10U * 60U * 1000U)
static EventGroupHandle_t bits;
static careloop_app_t *current;
static esp_timer_handle_t ap_timer;

bool careloop_wifi_connected(void) { return bits && (xEventGroupGetBits(bits) & WIFI_CONNECTED_BIT); }
static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void)arg; (void)data;
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) esp_wifi_connect();
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) { xEventGroupClearBits(bits, WIFI_CONNECTED_BIT); if (current && current->settings.configured) esp_wifi_connect(); }
  if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) xEventGroupSetBits(bits, WIFI_CONNECTED_BIT);
}
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
esp_err_t careloop_wifi_start(careloop_app_t *app) {
  current=app; bits=xEventGroupCreate(); esp_netif_init(); esp_event_loop_create_default(); esp_netif_create_default_wifi_sta(); esp_netif_create_default_wifi_ap(); wifi_init_config_t init=WIFI_INIT_CONFIG_DEFAULT(); ESP_ERROR_CHECK(esp_wifi_init(&init)); ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT,ESP_EVENT_ANY_ID,wifi_event,NULL,NULL)); ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT,IP_EVENT_STA_GOT_IP,wifi_event,NULL,NULL));
  if(!app->settings.configured) { start_ap(); return ESP_OK; }
  wifi_config_t sta={0}; strncpy((char*)sta.sta.ssid,app->settings.wifi_ssid,sizeof(sta.sta.ssid)-1); strncpy((char*)sta.sta.password,app->settings.wifi_password,sizeof(sta.sta.password)-1); sta.sta.threshold.authmode=WIFI_AUTH_WPA2_PSK; ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA)); ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA,&sta)); return esp_wifi_start();
}
