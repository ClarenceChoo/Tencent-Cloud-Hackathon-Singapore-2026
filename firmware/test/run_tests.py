"""Run each assertion case in a fresh process so all regressions are reported."""
import pathlib
import subprocess
import sys

cases = {
    'board_tests': ['psram_35', 'psram_36', 'psram_37', 'invalid_pin', 'duplicate_pin', 'mclk', 'drain', 'interrupt', 'drain_interrupt', 'drain_error', 'partial_write'],
    'board_usb_tests': ['usb_19', 'usb_20'],
    'network_tests': ['start_failure', 'checkin_start_failure', 'terminal_failure', 'checkin_terminal_failure', 'uncertain_failure', 'failed_audio_suppresses', 'receipt_failure', 'checkin_receipt_failure', 'interrupted_context', 'null_context', 'expired_context', 'success', 'reboot_suppression', 'checkin_reboot_suppression'],
}
failures = 0
for executable, names in cases.items():
    for name in names:
        result = subprocess.run([str(pathlib.Path(sys.argv[1]) / executable), name], capture_output=True, text=True)
        print(f"{'PASS' if result.returncode == 0 else 'FAIL'} {executable}/{name}")
        if result.returncode:
            failures += 1
            print(result.stderr.strip())
print(f'{sum(map(len, cases.values()))} cases, {failures} failures')
sys.exit(bool(failures))
