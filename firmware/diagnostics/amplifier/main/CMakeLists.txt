idf_component_register(SRCS "amplifier_diagnostic.c"
                       REQUIRES esp_driver_i2s esp_driver_gpio esp_psram spi_flash esp_system)
