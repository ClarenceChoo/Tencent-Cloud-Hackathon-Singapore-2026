#!/usr/bin/env python3
"""Package an already-built Parse Wi-Fi image. Never opens a serial port."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path


def package(build_dir: Path, site_dir: Path):
    config = (build_dir / 'config' / 'sdkconfig.json').read_text()
    settings = json.loads(config)
    expected = {'IDF_TARGET': 'esp32s3', 'CARELOOP_DIRECT_WIFI': True,
                'CARELOOP_MIC_BCLK_GPIO': 4, 'CARELOOP_MIC_WS_GPIO': 5,
                'CARELOOP_MIC_DATA_GPIO': 6, 'CARELOOP_MIC_LEFT_CHANNEL': True,
                'CARELOOP_AMP_ENABLE_GPIO': 17, 'CARELOOP_SPK_BCLK_GPIO': -1,
                'CARELOOP_SPK_WS_GPIO': -1, 'CARELOOP_SPK_DATA_GPIO': -1,
                'CARELOOP_PTT_GPIO': -1, 'ESPTOOLPY_FLASHSIZE': '16MB'}
    for key, value in expected.items():
        if settings.get(key) != value:
            raise ValueError('Unexpected firmware setting: ' + key)
    flasher = json.loads((build_dir / 'flasher_args.json').read_text())
    inputs = flasher['flash_files']
    expected_offsets = {0: ('bootloader', 0x8000), 0x8000: ('partition-table', 0x1000),
                        0x10000: ('application', 0x200000)}
    if {int(key, 0) for key in inputs} != set(expected_offsets):
        raise ValueError('Unexpected flash offsets; refusing to package data or credentials')
    destination = site_dir / 'public' / 'firmware' / 'parse-wifi-1'
    prepared = []
    for address, (name, maximum) in expected_offsets.items():
        relative = next(value for key, value in inputs.items() if int(key, 0) == address)
        source = (build_dir / relative).resolve()
        if build_dir.resolve() not in source.parents:
            raise ValueError('Build file is outside the build directory')
        data = source.read_bytes()
        if not data or len(data) > maximum or len(data) % 4:
            raise ValueError('Invalid binary size for ' + name)
        if name == 'partition-table':
            import struct
            partitions = []
            for at in range(0, min(len(data), 0xc00), 32):
                magic = struct.unpack_from('<H', data, at)[0]
                if magic in (0xffff, 0xebeb):
                    break
                if magic != 0x50aa:
                    raise ValueError('Invalid partition table')
                partitions.append(struct.unpack_from('<BBII', data, at + 2))
            if partitions != [(1, 2, 0x9000, 0x6000), (1, 1, 0xf000, 0x1000),
                              (0, 0, 0x10000, 0x200000)]:
                raise ValueError('Firmware partition table does not preserve the bench NVS layout')
        prepared.append((source, name, dict(name=name, path='/firmware/parse-wifi-1/' + name + '.bin',
            address=address, size=len(data), sha256=hashlib.sha256(data).hexdigest(), md5=hashlib.md5(data).hexdigest())))
    destination.mkdir(parents=True, exist_ok=True)
    for source, name, _ in prepared:
        shutil.copyfile(source, destination / (name + '.bin'))
    manifest = dict(version='parse-wifi-1', chip='ESP32-S3', flashSize=16777216,
                    backupSize=0x210000, sdkconfigSha256=hashlib.sha256(config.encode()).hexdigest(),
                    parts=[item[2] for item in prepared])
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-dir', type=Path, required=True)
    parser.add_argument('--site-dir', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(package(args.build_dir, args.site_dir), indent=2))
