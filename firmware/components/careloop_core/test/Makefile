CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -I../include

all: core_tests network_poll_tests

core_tests: test_core.c ../careloop_wav.c ../careloop_state.c ../careloop_protocol.c
	$(CC) $(CFLAGS) $^ -o $@

network_poll_tests: test_network_poll.c ../careloop_network_poll.c
	$(CC) $(CFLAGS) $^ -o $@

test: core_tests network_poll_tests
	./core_tests
	./network_poll_tests

clean:
	rm -f core_tests network_poll_tests
