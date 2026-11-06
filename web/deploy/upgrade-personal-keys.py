#!/usr/bin/env python3
"""Server-only backup and one-time provisioning for personal API credentials."""
import datetime
import os
from pathlib import Path
import secrets
import shutil
import sqlite3

if os.geteuid() != 0:
    raise SystemExit('Run on the deployment server with sudo.')

base = Path('/opt/codex-web')
data = Path('/var/lib/codex-web/workspace.sqlite')
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = base / 'backups' / f'personal-keys-{stamp}'
backup.mkdir(mode=0o700, parents=True)
os.chmod(backup, 0o700)
connection = sqlite3.connect(data)
if connection.execute("SELECT count(*) FROM runs WHERE status='running'").fetchone()[0]:
    connection.close()
    raise SystemExit('Active tasks exist. Finish them before upgrading.')
with sqlite3.connect(backup / 'workspace.sqlite') as snapshot:
    connection.backup(snapshot)
connection.close()
shutil.copytree('/etc/codex-web', backup / 'config')
shutil.copytree(base / 'current', backup / 'source', ignore=shutil.ignore_patterns('node_modules', 'dist', 'docker-cli'))
key = Path('/etc/codex-web/credentials-key')
if not key.exists():
    descriptor = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(secrets.token_bytes(32))
        stream.flush()
        os.fsync(stream.fileno())
if key.stat().st_size != 32:
    raise SystemExit('The credentials encryption key must contain exactly 32 bytes. Existing file was not overwritten.')
os.chmod(key, 0o600)
os.chown(key, 0, 0)
env = Path('/etc/codex-web/app.env')
lines = env.read_text().splitlines()
lines = [line for line in lines if not line.startswith(('OPENAI_API_KEY=', 'OPENAI_API_KEY_FILE='))]
env.write_text('\n'.join(lines) + '\n')
os.chmod(env, 0o600)
print(f'Prepared personal-key encryption. Existing data/config/source backup: {backup}')
print('No application container was restarted. No user data was deleted.')
