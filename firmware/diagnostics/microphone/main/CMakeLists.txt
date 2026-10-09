if(CONFIG_PARSE_MIC_BLE)
    set(transport "ble_transport.c")
else()
    set(transport "network_probe.c")
endif()
idf_component_register(SRCS "microphone_diagnostic.c" ${transport}
    REQUIRES careloop_core esp_driver_i2s esp_driver_gpio esp_psram
             nvs_flash mbedtls json bt esp_timer esp_http_client esp_wifi esp_event esp_netif)
