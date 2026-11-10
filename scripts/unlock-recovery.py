"""Interactive recovery: passphrase is hidden and never placed in process arguments."""
import getpass
import pathlib
import subprocess
import sys

if len(sys.argv) != 3:
    raise SystemExit('Usage: python scripts/unlock-recovery.py encrypted-key.json recovered-key.pem')
script = pathlib.Path(__file__).with_name('recovery-key.mjs')
phrase = getpass.getpass('Recovery passphrase (hidden): ')
result = subprocess.run(['node', str(script), 'decrypt', sys.argv[1], sys.argv[2]], input=phrase.encode('utf-8'))
raise SystemExit(result.returncode)
