#pragma once

#include <stdbool.h>
#include <string.h>

typedef enum {
  CARELOOP_RECEIPT_NONE,
  CARELOOP_RECEIPT_RETRY_CLAIM,
  CARELOOP_RECEIPT_FAIL_INTERRUPTED,
  CARELOOP_RECEIPT_RETRY_COMPLETE,
  CARELOOP_RECEIPT_RETRY_FAILED
} careloop_receipt_action_t;

static inline careloop_receipt_action_t careloop_receipt_action(const char *state,
                                                                 bool boot_recovery_complete) {
  if (!state) return CARELOOP_RECEIPT_NONE;
  if (!strcmp(state, "claiming")) return CARELOOP_RECEIPT_RETRY_CLAIM;
  if (!strcmp(state, "started"))
    return boot_recovery_complete ? CARELOOP_RECEIPT_NONE : CARELOOP_RECEIPT_FAIL_INTERRUPTED;
  if (!strcmp(state, "complete_pending")) return CARELOOP_RECEIPT_RETRY_COMPLETE;
  if (!strcmp(state, "failed_pending")) return CARELOOP_RECEIPT_RETRY_FAILED;
  return CARELOOP_RECEIPT_NONE;
}

static inline bool careloop_terminal_receipt_resolved(int http_status) {
  return (http_status >= 200 && http_status < 300) ||
         http_status == 404 || http_status == 409 || http_status == 410;
}
