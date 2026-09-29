#include <assert.h>
#include "careloop_network_poll.h"

typedef struct { int drains, reconciles, recoveries, heartbeats; } calls_t;
static void drain(void *ctx) { ((calls_t *)ctx)->drains++; }
static void reconcile(void *ctx) { ((calls_t *)ctx)->reconciles++; }
static void recover(void *ctx) { ((calls_t *)ctx)->recoveries++; }
static void heartbeat(void *ctx) { ((calls_t *)ctx)->heartbeats++; }

int main(void) {
  careloop_network_poll_t poll = {0};
  calls_t calls = {0};
  const careloop_network_ops_t ops = {drain, reconcile, recover, heartbeat};
  careloop_network_tick(&poll, 0, false, false, &ops, &calls);
  assert(calls.drains == 0 && calls.reconciles == 0 && calls.recoveries == 0);
  /* Accepted turns must be polled over HTTPS even if WSS never connects,
   * disconnects, or cannot allocate a client. No audio is re-uploaded here. */
  careloop_network_tick(&poll, 1000000, true, false, &ops, &calls);
  assert(calls.reconciles == 1 && calls.recoveries == 1 && calls.heartbeats == 0);
  for (int64_t now = 2000000; now < 6000000; now += 1000000)
    careloop_network_tick(&poll, now, true, false, &ops, &calls);
  assert(calls.drains == 5 && calls.reconciles == 1 && calls.recoveries == 1);
  /* Attempts, not successes, set the cadence: failed HTTP must not spin. */
  careloop_network_tick(&poll, 6000000, true, false, &ops, &calls);
  assert(calls.reconciles == 2 && calls.recoveries == 2 && calls.heartbeats == 0);
  careloop_network_tick(&poll, 11000000, true, true, &ops, &calls);
  assert(calls.reconciles == 3 && calls.recoveries == 3 && calls.heartbeats == 1);
  careloop_network_tick(&poll, 16000000, true, false, &ops, &calls);
  assert(calls.reconciles == 4 && calls.recoveries == 4 && calls.heartbeats == 1);
  careloop_network_tick(&poll, 17000000, false, false, &ops, &calls);
  assert(calls.reconciles == 4 && calls.recoveries == 4);
  careloop_network_tick(&poll, 18000000, true, false, &ops, &calls);
  assert(calls.reconciles == 5 && calls.recoveries == 5);
  return 0;
}
