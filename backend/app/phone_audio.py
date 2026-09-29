"""Bounded, phone-only AAC/M4A normalization. Pendant input remains strict WAV."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import wave

from fastapi import HTTPException
from .services import validate_wav

MAX_INPUT = 2 * 1024 * 1024
DECODER_SLOTS = threading.BoundedSemaphore(2)


def _decode(executable, arguments):
    binary = shutil.which(executable)
    if not binary:
        raise HTTPException(503, 'Phone audio decoder is not installed on this server')
    try:
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name('audio_subprocess.py')), binary, *arguments],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
            env={'PATH': os.environ.get('PATH', ''), 'LANG': 'C'}, check=False)
    except (subprocess.TimeoutExpired, OSError):
        raise HTTPException(400, 'Phone audio could not be decoded within its limits')
    if result.returncode != 0:
        raise HTTPException(400, 'Phone audio is malformed or unsupported')
    return result.stdout


def normalize_phone_audio(body: bytes, mime: str) -> bytes:
    if not DECODER_SLOTS.acquire(blocking=False):
        raise HTTPException(429, 'Phone audio decoder is busy; retry shortly', headers={'Retry-After': '1'})
    try:
        return _normalize(body, mime)
    finally:
        DECODER_SLOTS.release()


def _normalize(body: bytes, mime: str) -> bytes:
    if len(body) > MAX_INPUT:
        raise HTTPException(413, 'Phone audio exceeds 2 MiB')
    if mime == 'audio/wav':
        try:
            validate_wav(body)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return body
    if mime not in {'audio/mp4', 'audio/x-m4a'} or len(body) < 12 or body[4:8] != b'ftyp':
        raise HTTPException(400, 'Use PCM WAV or an AAC recording in an M4A container with its matching Content-Type')
    with tempfile.TemporaryDirectory(prefix='parse-audio-') as temporary:
        path = Path(temporary) / 'input.m4a'
        with path.open('xb') as output:
            os.chmod(path, 0o600)
            output.write(body)
        # Only the MOV demuxer is enabled. Its external data references are disabled;
        # protocols exclude network access, playlists and nested container formats.
        input_args = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov',
                      '-enable_drefs', '0', '-use_absolute_path', '0', '-i', str(path)]
        metadata = _decode('ffprobe', ['-v', 'error', *input_args, '-show_entries',
            'format=duration:stream=codec_type,codec_name,sample_rate,channels', '-of', 'json'])
        if len(metadata) > 16384:
            raise HTTPException(400, 'Phone recording contains excessive metadata')
        try:
            info = json.loads(metadata)
            streams = info['streams']
            duration = float(info['format']['duration'])
            if len(streams) != 1 or streams[0]['codec_type'] != 'audio' or streams[0]['codec_name'] != 'aac':
                raise ValueError()
            if not 0.3 <= duration <= 20 or not 1 <= int(streams[0]['channels']) <= 2 or not 8000 <= int(streams[0]['sample_rate']) <= 96000:
                raise ValueError()
        except (KeyError, ValueError, TypeError, json.JSONDecodeError):
            raise HTTPException(400, 'Phone recording must be one AAC audio stream lasting 0.3–20 seconds')
        pcm = _decode('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '1', *input_args,
            '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', '20.1', '-ac', '1', '-ar', '16000',
            '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'])
        if len(pcm) < 9600 or len(pcm) > 640000 or len(pcm) % 2:
            raise HTTPException(400, 'Decoded phone audio exceeds the duration or sample limits')
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(pcm)
        normalized = buffer.getvalue()
        validate_wav(normalized)
        return normalized
