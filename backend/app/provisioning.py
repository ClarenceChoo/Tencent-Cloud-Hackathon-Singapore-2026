"""Explicit factory provisioning. Device secrets are written to private files."""
import csv
import io
import json
import os
import secrets
from datetime import timedelta
from pathlib import Path

from sqlalchemy import update

from .config import service_base_url
from .models import Device
from .security import sha256, utcnow, iso


def claim_material(minutes: int):
    if not 5 <= minutes <= 1440:
        raise ValueError('Claim lifetime must be between 5 and 1440 minutes.')
    return '%s-%s' % (secrets.token_hex(2).upper(), secrets.token_hex(2).upper()), utcnow() + timedelta(minutes=minutes)


def private_file(path: Path, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(text)
    except Exception:
        path.unlink()
        raise


def prepare_device(db, output_dir: str, backend_url: str, minutes: int = 60) -> str:
    url = service_base_url(backend_url)
    code, expiry = claim_material(minutes)
    target = Path(output_dir).absolute()
    # Never overwrite another pendant's credential bundle.
    target.mkdir(mode=0o700, parents=True, exist_ok=False)
    written = []
    try:
        credential = 'dev_' + secrets.token_urlsafe(32)
        setup_password = secrets.token_hex(8).upper()
        device = Device(credential_hash=sha256(credential), claim_code_hash=sha256(code),
                        claim_expires_at=expiry, capabilities=['wav-16k-mono', 'wss-events'])
        db.add(device); db.flush()
        output = io.StringIO(newline='')
        writer = csv.writer(output, lineterminator='\n')
        writer.writerow(['key', 'type', 'encoding', 'value'])
        writer.writerow(['careloop', 'namespace', '', ''])
        for key, value in [('token', credential), ('setup_pw', setup_password), ('backend', url)]:
            writer.writerow([key, 'data', 'string', value])
        # No saved SSID: first boot opens the password-protected setup network.
        manifest = {'device_id': device.id, 'backend_url': url, 'claim_expires_at': iso(expiry),
                    'protocol_version': 1, 'nvs_partition': 'nvs', 'nvs_size': '0x6000',
                    'nvs_file': 'device-nvs.csv', 'credential_location': 'device-nvs.csv only'}
        instructions = f'''Parse cardholder setup — keep this sheet private

Device ID: {device.id}
One-use pairing code: {code}
Pairing code expires (UTC): {iso(expiry)}
Setup network: CareLoop-XXXX (the last four characters depend on the device)
Setup Wi-Fi password: {setup_password}
Setup page: http://192.168.4.1/
Service address: {url}

1. Flash this pendant with its supplier-approved Parse firmware and its own NVS file.
2. In Parse → Settings → Pair your cardholder, enter the pairing code above.
3. Power on the pendant. Join its setup network and open the setup page.
4. Enter a 2.4 GHz WPA2 Wi-Fi network or compatible phone hotspot and the service address.
5. Rejoin your usual network. Parse should show the cardholder Online after its heartbeat.
6. With the live voice service configured, speak a fictional care note, listen to the
   read-back, then explicitly confirm it. Check the timeline and chosen sharing recipient.

The pairing code is not the device credential or Wi-Fi setup password.
If the code expires before delivery, an administrator can renew the claim code for
this same device ID. No firmware reflash is needed for a renewed pairing code.
Do not send device-nvs.csv or the device credential to a public issue, chat or Git.
'''
        for name, content in [('device-nvs.csv', output.getvalue()), ('device.json', json.dumps(manifest, indent=2)+'\n'), ('owner-setup.txt', instructions)]:
            file = target / name
            private_file(file, content); written.append(file)
        db.commit()
        return device.id
    except Exception:
        db.rollback()
        for file in written:
            file.unlink()
        target.rmdir()
        raise


def renew_claim(db, device_id: str, minutes: int = 60) -> tuple[str, str]:
    code, expiry = claim_material(minutes)
    changed = db.execute(update(Device).where(Device.id == device_id, Device.patient_id.is_(None),
                                             Device.claimed_at.is_(None), Device.revoked_at.is_(None))
                         .values(claim_code_hash=sha256(code), claim_expires_at=expiry))
    if changed.rowcount != 1:
        db.rollback()
        raise ValueError('Only an existing, unclaimed, unrevoked device can receive a new pairing code.')
    db.commit()
    return code, iso(expiry)
