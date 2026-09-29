#include "careloop_network_poll.h"

void careloop_network_tick(careloop_network_poll_t *poll, int64_t now_us,
                          bool wifi_connected, bool websocket_connected,
                          const careloop_network_ops_t *ops, void *context) {
  if (!wifi_connected) {
    poll->polled = false;
    return;
  }
  ops->drain_messages(context);
  if (poll->polled && now_us >= poll->last_poll_us &&
      now_us - poll->last_poll_us < CARELOOP_NETWORK_POLL_US) return;
  poll->polled = true;
  poll->last_poll_us = now_us;
  ops->reconcile(context);
  ops->recover_turn(context);
  if (websocket_connected) ops->heartbeat(context);
}
