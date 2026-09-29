#ifndef CARELOOP_NETWORK_POLL_H
#define CARELOOP_NETWORK_POLL_H
#include <stdbool.h>
#include <stdint.h>

#define CARELOOP_NETWORK_POLL_US 5000000LL

typedef struct {
  int64_t last_poll_us;
  bool polled;
} careloop_network_poll_t;

typedef struct {
  void (*drain_messages)(void *context);
  void (*reconcile)(void *context);
  void (*recover_turn)(void *context);
  void (*heartbeat)(void *context);
} careloop_network_ops_t;

/* All callbacks run synchronously in the network task, never in the WS event
 * handler. HTTP attempts are bounded even when reconciliation keeps failing. */
void careloop_network_tick(careloop_network_poll_t *poll, int64_t now_us,
                          bool wifi_connected, bool websocket_connected,
                          const careloop_network_ops_t *ops, void *context);
#endif
