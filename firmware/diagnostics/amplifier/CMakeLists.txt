cmake_minimum_required(VERSION 3.16)
if(NOT DEFINED SDKCONFIG_DEFAULTS)
    set(SDKCONFIG_DEFAULTS
        "${CMAKE_CURRENT_LIST_DIR}/../../sdkconfig.esp32s3-n16r8-uart;${CMAKE_CURRENT_LIST_DIR}/sdkconfig.defaults")
endif()
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(parse_amplifier_diagnostic)
