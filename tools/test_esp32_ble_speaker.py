import hashlib
import io
from pathlib import Path
import struct
import sys
import unittest
import wave

sys.path.insert(0, str(Path(__file__).resolve().parent))
from esp32_ble_speaker import send_wav, validate_wav


def sample_wav(rate=16000):
    result = io.BytesIO()
    with wave.open(result, "wb") as wav:
        wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        wav.writeframes(struct.pack("<h", 1000) * 4800)
    return result.getvalue()


class FakeBoard:
    def __init__(self, capability=1, final_state=4, error=0, bad_hash=False):
        self.capability, self.final_state = capability, final_state
        self.error, self.bad_hash = error, bad_hash
        self.calls, self.received = [], bytearray()
        self.finished = False

    async def __call__(self, payload, *, read_reply=True):
        self.calls.append(payload[0])
        if payload[0] == 9:
            state = self.final_state if self.finished else 0
            return bytes((self.capability, state)) + struct.pack("<I", self.error if self.finished else 0)
        if payload[0] == 5:
            self.expected_size = struct.unpack_from("<I", payload, 1)[0]
            self.expected_hash = payload[5:]
        elif payload[0] == 6:
            assert not read_reply
            assert struct.unpack_from("<I", payload, 1)[0] == len(self.received)
            self.received.extend(payload[5:])
        elif payload[0] == 7:
            assert len(self.received) == self.expected_size
            assert hashlib.sha256(self.received).digest() == self.expected_hash
            self.finished = True
            return b"x" * 32 if self.bad_hash else self.expected_hash
        return b""


class SpeakerTest(unittest.IsolatedAsyncioTestCase):
    async def test_success_requires_matching_hash_and_completed_driver(self):
        board, wav = FakeBoard(), sample_wav()
        report = await send_wav(board, wav, chunk_size=137)
        self.assertEqual(bytes(board.received), wav)
        self.assertEqual(board.calls[0], 9)
        self.assertEqual(board.calls[-2:], [7, 9])
        self.assertTrue(report["checksum_verified_on_esp32"])
        self.assertTrue(report["speaker_driver_completed"])
        self.assertEqual(report["audibility"], "Requires a listening check")

    async def test_invalid_format_rejected_before_board_io(self):
        board = FakeBoard()
        for wav in (b"", sample_wav(8000), sample_wav()[:-1], sample_wav() + b"junk"):
            with self.assertRaises(ValueError):
                await send_wav(board, wav)
        self.assertFalse(board.calls)

    async def test_unavailable_speaker_does_not_start_upload(self):
        board = FakeBoard(capability=0)
        with self.assertRaisesRegex(RuntimeError, "not enabled"):
            await send_wav(board, sample_wav())
        self.assertEqual(board.calls, [9])

    async def test_hash_mismatch_is_not_success(self):
        board = FakeBoard(bad_hash=True)
        with self.assertRaisesRegex(RuntimeError, "SHA-256"):
            await send_wav(board, sample_wav())

    async def test_playback_failure_is_not_success(self):
        for state in (4, 5):
            with self.assertRaisesRegex(RuntimeError, "driver failed"):
                await send_wav(FakeBoard(final_state=state, error=0x103), sample_wav())

    async def test_pending_playback_times_out(self):
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            await send_wav(FakeBoard(final_state=3), sample_wav(), timeout=.03, poll=.01)

    async def test_rejected_chunk_cannot_complete(self):
        async def reject(payload, **kwargs):
            if payload[0] == 6:
                raise RuntimeError("ATT write rejected")
            return await board(payload, **kwargs)
        board = FakeBoard()
        with self.assertRaisesRegex(RuntimeError, "ATT write rejected"):
            await send_wav(reject, sample_wav())
        self.assertNotIn(7, board.calls)


if __name__ == "__main__":
    unittest.main()
