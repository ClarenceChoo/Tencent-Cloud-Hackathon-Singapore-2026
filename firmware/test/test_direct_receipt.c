#include <assert.h>
#include <string.h>
#include "careloop_direct_receipt.h"

int main(int argc, char **argv) {
  assert(argc == 2);
  if (!strcmp(argv[1], "boot_claim_recovered")) {
    assert(careloop_receipt_action("claiming", false) == CARELOOP_RECEIPT_RETRY_CLAIM);
    assert(careloop_receipt_action("started", false) == CARELOOP_RECEIPT_FAIL_INTERRUPTED);
    /* Once claiming was recovered and queued this runtime capture is not a reboot interruption. */
    assert(careloop_receipt_action("started", true) == CARELOOP_RECEIPT_NONE);
  } else if (!strcmp(argv[1], "boot_started")) {
    assert(careloop_receipt_action("started", false) == CARELOOP_RECEIPT_FAIL_INTERRUPTED);
    assert(careloop_receipt_action("started", true) == CARELOOP_RECEIPT_NONE);
  } else if (!strcmp(argv[1], "terminal_retry")) {
    assert(careloop_receipt_action("complete_pending", true) == CARELOOP_RECEIPT_RETRY_COMPLETE);
    assert(careloop_receipt_action("failed_pending", true) == CARELOOP_RECEIPT_RETRY_FAILED);
  } else if (!strcmp(argv[1], "expired_terminal")) {
    assert(careloop_terminal_receipt_resolved(200));
    assert(careloop_terminal_receipt_resolved(404));
    assert(careloop_terminal_receipt_resolved(409));
    assert(careloop_terminal_receipt_resolved(410));
    assert(!careloop_terminal_receipt_resolved(500));
    assert(!careloop_terminal_receipt_resolved(0));
  } else {
    return 2;
  }
  return 0;
}
