"""Outward-only cloud control with durable, at-most-once capture receipts."""
import json
from pathlib import Path
import threading
from uuid import UUID, uuid4

from parse_online_relay import private_json


class RemoteControl:
    def __init__(self, relay, folder, snapshot, start_work):
        self.relay, self.folder = relay, Path(folder)
        self.snapshot, self.start_work = snapshot, start_work
        self.running = set()
        self.lock = threading.RLock()

    def tick(self):
        """Poll for an explicit dashboard request; never record on heartbeat alone."""
        if not self.relay.session:
            return
        value = self.relay.control({"status": self.snapshot()})
        command = value.get("command")
        if not command:
            return
        identifier = str(UUID(command["id"]))
        room = str(UUID(self.relay.session["room_id"]))
        path = self.folder / f"parse-command-{room}-{identifier}.json"
        with self.lock:
            if identifier in self.running:
                return
            receipt = json.loads(path.read_text()) if path.exists() else None
            if receipt and receipt["state"] in {"started", "complete", "failed"}:
                # A restart after the durable started marker must never repeat
                # microphone capture. The user can issue a fresh request.
                outcome = "complete" if receipt["state"] == "complete" else "failed"
                self.relay.control({"action": outcome, "commandId": identifier, "claimId": receipt["claim_id"]})
                return
            if self.snapshot()["busy"]:
                return
            if receipt is None:
                if command.get("state") != "queued":
                    return
                receipt = {"claim_id": str(uuid4()), "state": "claiming", "kind": command["kind"]}
                private_json(path, receipt)
            value = self.relay.control({"action": "claim", "commandId": identifier, "claimId": receipt["claim_id"]})
            if not value.get("claimed"):
                return
            receipt["state"] = "started"
            private_json(path, receipt)
            self.running.add(identifier)

        def finished(success):
            with self.lock:
                receipt["state"] = "complete" if success else "failed"
                private_json(path, receipt)
                self.running.discard(identifier)

        try:
            if not self.start_work(receipt["kind"], finished):
                finished(False)
        except Exception:
            finished(False)
            raise
