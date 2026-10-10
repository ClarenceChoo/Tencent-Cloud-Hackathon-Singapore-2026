CC ?= cc
CFLAGS ?= -std=c11 -O1 -Wall -Wextra -Werror
CPPFLAGS += -Istubs -I../main/include -I../components/careloop_core/include
BUILD ?= .build
ifeq ($(shell uname -s),Darwin)
GCFLAGS = -Wl,-dead_strip
else
GCFLAGS = -Wl,--gc-sections
endif
SOURCES = ../components/careloop_core/careloop_protocol.c ../components/careloop_core/careloop_wav.c

.PHONY: test clean
test: $(BUILD)/board_tests $(BUILD)/board_usb_tests $(BUILD)/network_tests $(BUILD)/direct_receipt_tests
	python3 run_tests.py $(BUILD)

$(BUILD):
	mkdir -p $@

$(BUILD)/board_tests: test_board_audio.c ../main/board_audio.c $(wildcard stubs/*.h stubs/*/*.h ../main/include/*.h ../components/careloop_core/include/*.h) $(SOURCES) | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -ffunction-sections -fdata-sections test_board_audio.c $(SOURCES) $(GCFLAGS) -o $@

$(BUILD)/network_tests: test_network_playback.c ../main/device_network.c $(wildcard stubs/*.h stubs/*/*.h ../main/include/*.h ../components/careloop_core/include/*.h) $(SOURCES) | $(BUILD)
	# device_network.c has a pre-existing signed WebSocket payload comparison.
	$(CC) $(CPPFLAGS) $(CFLAGS) -Wno-sign-compare -ffunction-sections -fdata-sections test_network_playback.c $(SOURCES) $(GCFLAGS) -o $@

$(BUILD)/direct_receipt_tests: test_direct_receipt.c ../main/include/careloop_direct_receipt.h | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) test_direct_receipt.c -o $@

clean:
	rm -f $(BUILD)/board_tests $(BUILD)/board_usb_tests $(BUILD)/network_tests

$(BUILD)/board_usb_tests: test_board_audio.c ../main/board_audio.c $(wildcard stubs/*.h stubs/*/*.h ../main/include/*.h ../components/careloop_core/include/*.h) $(SOURCES) | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -DCONFIG_ESP_CONSOLE_SECONDARY_USB_SERIAL_JTAG=1 -ffunction-sections -fdata-sections test_board_audio.c $(SOURCES) $(GCFLAGS) -o $@
