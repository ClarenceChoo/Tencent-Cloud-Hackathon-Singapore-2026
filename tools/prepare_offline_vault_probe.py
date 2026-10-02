#!/usr/bin/env python3
"""Prepare a separate fictional Expo probe; never build, install or operate a device."""
import argparse
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve()
    if not out.is_relative_to(ROOT / "runtime") or out == ROOT / "runtime":
        raise SystemExit("Choose a new directory inside the ignored runtime folder.")
    source = ROOT / "mobile/test/manual/offline-vault"
    dependencies = ROOT / "mobile/node_modules"
    if not dependencies.is_dir():
        raise SystemExit("Install the repository's pinned mobile dependencies first.")
    out.mkdir(parents=True, mode=0o700, exist_ok=False)
    for filename in ("index.ts", "App.tsx", "probe.ts", "app.config.js"):
        shutil.copyfile(source / filename, out / filename)
    package = json.loads((ROOT / "mobile/package.json").read_text())
    package["main"] = "index.ts"
    package["scripts"] = {"start": "expo start --dev-client", "android": "expo run:android",
                          "ios": "expo run:ios", "typecheck": "tsc --noEmit"}
    (out / "package.json").write_text(json.dumps(package, indent=2) + "\n")
    shutil.copyfile(ROOT / "mobile/package-lock.json", out / "package-lock.json")
    shutil.copyfile(ROOT / "mobile/tsconfig.json", out / "tsconfig.json")
    (out / "node_modules").symlink_to(dependencies, target_is_directory=True)
    (out / "PROBE_ONLY.txt").write_text(
        "Separate fictional G1 primitive probe. No account, microphone, upload, or production vault.\n"
        "Application identifier: sg.parse.vaultprobe. Physical-device gate remains unpassed.\n")
    print("Prepared fictional probe project: " + str(out))
    print("No build, installation, device reset, backup, or network action was performed.")


if __name__ == "__main__":
    main()
