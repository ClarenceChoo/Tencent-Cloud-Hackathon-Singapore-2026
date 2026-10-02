#pragma once
#include <stdbool.h>
typedef void *esp_websocket_client_handle_t;
typedef const char *esp_event_base_t;
typedef struct { int payload_offset,op_code,payload_len,data_len;const char *data_ptr; } esp_websocket_event_data_t;
typedef struct {const char *uri,*headers; int (*crt_bundle_attach)(void*);int network_timeout_ms;bool disable_auto_reconnect;} esp_websocket_client_config_t;
#define WEBSOCKET_EVENT_DATA 1
#define WEBSOCKET_EVENT_ANY -1
#define WS_TRANSPORT_OPCODES_TEXT 1
esp_websocket_client_handle_t esp_websocket_client_init(const esp_websocket_client_config_t*);
int esp_websocket_register_events(esp_websocket_client_handle_t,int,void (*)(void*,esp_event_base_t,int32_t,void*),void*);
int esp_websocket_client_start(esp_websocket_client_handle_t);
int esp_websocket_client_stop(esp_websocket_client_handle_t);
int esp_websocket_client_destroy(esp_websocket_client_handle_t);
bool esp_websocket_client_is_connected(esp_websocket_client_handle_t);
int esp_websocket_client_send_text(esp_websocket_client_handle_t,const char*,int,unsigned);
