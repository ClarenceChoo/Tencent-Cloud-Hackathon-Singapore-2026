import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from esp32_audio_dashboard import play_speaker_reply


class RelaySpeakerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.reply = Path(self.tmp.name) / "reply.wav"
        self.reply.write_bytes(b"existing synthesized speech; helper owns WAV validation")
        self.report = self.reply.with_suffix(".speaker.json")

    def result(self, **changes):
        value = {"speaker_driver_completed": True, "checksum_verified_on_esp32": True,
                 "sha256": hashlib.sha256(self.reply.read_bytes()).hexdigest()}
        value.update(changes)
        return value

    def run_helper(self, value=None, code=0):
        def run(command, **kwargs):
            self.assertFalse(self.report.exists(), "A stale success must be removed first")
            self.assertIn("--input", command)
            self.assertNotIn("--output", command, "The speaker helper must not record")
            self.assertLessEqual(kwargs["timeout"], 190)
            if value is not None:
                self.report.write_text(json.dumps(value))
            return subprocess.CompletedProcess(command, code, stdout="speaker helper result\n")
        return patch("esp32_audio_dashboard.subprocess.run", side_effect=run)

    def test_verified_playback_preserves_reply(self):
        original = self.reply.read_bytes()
        with self.run_helper(self.result()):
            result = play_speaker_reply("python", "test-port", self.reply)
        self.assertTrue(result["speaker_driver_completed"])
        self.assertEqual(self.reply.read_bytes(), original)

    def test_stale_report_cannot_mask_missing_completion(self):
        self.report.write_text(json.dumps(self.result()))
        with self.run_helper(), self.assertRaisesRegex(RuntimeError, "did not complete"):
            play_speaker_reply("python", "test-port", self.reply)

    def test_helper_failure_cannot_mask_completion(self):
        with self.run_helper(self.result(), code=1), self.assertRaises(RuntimeError):
            play_speaker_reply("python", "test-port", self.reply)

    def test_wrong_clip_or_incomplete_driver_is_not_success(self):
        for change in ({"sha256": "wrong"}, {"speaker_driver_completed": False},
                       {"checksum_verified_on_esp32": False}):
            with self.run_helper(self.result(**change)), self.assertRaisesRegex(RuntimeError, "verified"):
                play_speaker_reply("python", "test-port", self.reply)


if __name__ == "__main__":
    unittest.main()
