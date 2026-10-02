#pragma once
#include <stddef.h>
#include <stdbool.h>
typedef void *esp_http_client_handle_t;
typedef int esp_http_client_method_t;
typedef struct {int event_id,data_len;void *data,*user_data;} esp_http_client_event_t;
typedef struct {const char *url;int (*event_handler)(esp_http_client_event_t*);void *user_data;int timeout_ms;int (*crt_bundle_attach)(void*);bool keep_alive_enable,disable_auto_redirect;} esp_http_client_config_t;
#define HTTP_EVENT_ON_DATA 1
#define HTTP_METHOD_GET 0
#define HTTP_METHOD_POST 1
esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t*);
int esp_http_client_cleanup(esp_http_client_handle_t);
int esp_http_client_set_method(esp_http_client_handle_t,esp_http_client_method_t);
int esp_http_client_set_header(esp_http_client_handle_t,const char*,const char*);
int esp_http_client_set_post_field(esp_http_client_handle_t,const char*,int);
int esp_http_client_perform(esp_http_client_handle_t);
int esp_http_client_open(esp_http_client_handle_t,int);
int esp_http_client_fetch_headers(esp_http_client_handle_t);
int esp_http_client_get_status_code(esp_http_client_handle_t);
int esp_http_client_close(esp_http_client_handle_t);
int esp_http_client_read(esp_http_client_handle_t,char*,int);
