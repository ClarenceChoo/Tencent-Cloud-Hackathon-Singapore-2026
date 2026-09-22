idf_component_register(SRCS "app_main.c" "board_audio.c" "settings.c" "wifi_setup.c" "device_network.c" "local_prompts.c"
                       INCLUDE_DIRS "include"
                       REQUIRES careloop_core nvs_flash esp_wifi esp_event esp_netif esp_http_server esp_http_client
                                esp-tls esp_websocket_client driver json esp_timer lwip
                       EMBED_FILES "assets/not_connected.wav" "assets/not_sent.wav" "assets/receipt_unconfirmed.wav" "assets/low_battery.wav" "assets/processing_failed.wav" "assets/saved.wav")
