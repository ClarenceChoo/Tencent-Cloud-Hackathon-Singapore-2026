CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -I../include

all: core_tests

core_tests: test_core.c ../careloop_wav.c ../careloop_state.c ../careloop_protocol.c
	$(CC) $(CFLAGS) $^ -o $@

test: core_tests
	./core_tests

clean:
	rm -f core_tests
