#!/usr/bin/env python3
"""Server-only, staged Cloudflare ingress setup. Never prints credentials.

prepare: back up state, provision a dedicated origin token and HTTP ACME vhost.
tls: issue the origin certificate and enable the authenticated HTTPS vhost.
activate: switch the public origin and redirect the legacy IP after Worker QA.
rollback: restore the last activation's ingress configuration, never its database.
"""
import datetime
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = Path('/opt/codex-web')
CONFIG = Path('/etc/codex-web')
HOST = 'origin-kivo.iptnet.xyz'
PUBLIC = 'https://kivo.iptnet.xyz'
SITE = Path('/etc/nginx/sites-available/kivo-origin')
LINK = Path('/etc/nginx/sites-enabled/kivo-origin')
STATE = CONFIG / 'cloudflare-backup-path'
ACTIVATION_STATE = CONFIG / 'cloudflare-activation-path'

def run(*args):
    subprocess.run(args, check=True)

def private_write(path, text):
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(text)
    os.chmod(path, 0o600)

def atomic_write(path, data, mode=0o600):
    temporary = path.with_name(path.name + '.tmp-' + secrets.token_hex(6))
    try:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)

def save_metadata(backup, metadata):
    atomic_write(backup / 'activation.json', (json.dumps(metadata, indent=2) + '\n').encode())

def activation_snapshot():
    assert ACTIVATION_STATE.exists(), 'No activation snapshot exists'
    backup = Path(ACTIVATION_STATE.read_text().strip())
    assert backup.parent == BASE / 'backups' and backup.name.startswith('cloudflare-activate-'), 'Invalid activation snapshot path'
    return backup, json.loads((backup / 'activation.json').read_text())

def recreate(backup, metadata):
    # Preserve the running image ID and Compose project, even if a tag has moved
    # or /current has changed since the snapshot. Only the env file is switched.
    run('docker', 'compose', '-p', metadata['compose_project'], '-f', str(backup / 'compose.yaml'),
        '-f', str(backup / 'image-override.json'), 'up', '-d', '--no-deps',
        '--force-recreate', '--pull', 'never', 'web')

def wait_healthy(expected_origin, timeout=75):
    deadline = time.monotonic() + timeout
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.monotonic() < deadline:
        try:
            with opener.open('http://127.0.0.1:18300/healthz', timeout=2) as response:
                healthy = response.status == 200 and json.loads(response.read(4096)).get('ok') is True
            if healthy:
                # Compare only this non-secret setting; never print container env.
                result = subprocess.run(['docker', 'exec', 'codex-workspace-web', 'node', '-e',
                    'process.exit((process.env.PUBLIC_ORIGIN || "") === process.argv[1] ? 0 : 1)', expected_origin],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
                if result.returncode == 0:
                    return
        except (OSError, ValueError, urllib.error.URLError, subprocess.TimeoutExpired):
            pass
        time.sleep(1)
    raise RuntimeError('Backend did not become healthy with the expected public origin')

def public_origin(data):
    values = [line.split('=', 1)[1].strip().strip('"\'') for line in data.decode().splitlines()
              if line.startswith('PUBLIC_ORIGIN=')]
    return values[-1] if values else ''

def active_runs():
    with sqlite3.connect('file:/var/lib/codex-web/workspace.sqlite?mode=ro', uri=True) as db:
        return db.execute("SELECT count(*) FROM runs WHERE status='running'").fetchone()[0]

def prepare():
    if not STATE.exists():
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup = BASE / 'backups' / ('cloudflare-' + stamp)
        backup.mkdir(mode=0o700)
        with sqlite3.connect('file:/var/lib/codex-web/workspace.sqlite?mode=ro', uri=True) as db:
            with sqlite3.connect(backup / 'workspace.sqlite') as copy:
                db.backup(copy)
        shutil.copytree(CONFIG, backup / 'config')
        shutil.copytree('/etc/nginx', backup / 'nginx', symlinks=True)
        shutil.copytree(BASE / 'current', backup / 'source', ignore=shutil.ignore_patterns('docker-cli', 'dist', 'node_modules'))
        private_write(STATE, str(backup) + '\n')
    token_file = CONFIG / 'cloudflare-origin-token'
    if not token_file.exists():
        private_write(token_file, secrets.token_hex(32) + '\n')
    token = token_file.read_text().strip()
    assert re.fullmatch(r'[a-f0-9]{64}', token), 'Existing origin token has unexpected format'
    private_write(Path('/etc/nginx/conf.d/kivo-origin-auth.conf'),
                  'map $http_x_kivo_origin_token $kivo_origin_allowed {\n default 0;\n ~^' + token + '$ 1;\n}\n'
                  'map $http_x_kivo_client_ip $kivo_client_valid {\n default 0;\n ~^[0-9a-fA-F:.]+$ 1;\n}\n')
    if not SITE.exists():
        SITE.write_text(http_vhost())
    if not LINK.exists():
        LINK.symlink_to(SITE)
    run('nginx', '-t')
    run('systemctl', 'reload', 'nginx')
    print('Origin prepared; current application unchanged. Backup:', STATE.read_text().strip())

def http_vhost():
    return f'''server {{
    listen 80;
    listen [::]:80;
    server_name {HOST};
    location ^~ /.well-known/acme-challenge/ {{ root /var/www/codex-acme; }}
    location / {{ return 403; }}
}}
'''

def tls():
    assert STATE.exists(), 'Run prepare first'
    run(str(BASE / 'certbot-venv/bin/certbot'), 'certonly', '--webroot', '-w', '/var/www/codex-acme',
        '--cert-name', 'kivo-origin', '-d', HOST, '--non-interactive', '--keep-until-expiring')
    SITE.write_text(http_vhost() + f'''
server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {HOST};
    ssl_certificate /etc/letsencrypt/live/kivo-origin/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/kivo-origin/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 2m;
    if ($kivo_origin_allowed = 0) {{ return 403; }}
    if ($kivo_client_valid = 0) {{ return 400; }}
    location ~ ^/(api(/|$)|healthz$) {{
        proxy_pass http://127.0.0.1:18300;
        proxy_http_version 1.1;
        proxy_set_header Host kivo.iptnet.xyz;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $http_x_kivo_client_ip;
        proxy_set_header X-Real-IP $http_x_kivo_client_ip;
        proxy_set_header X-Kivo-Origin-Token "";
        proxy_set_header X-Kivo-Client-IP "";
        proxy_set_header Connection "";
        proxy_read_timeout 700s;
        proxy_send_timeout 60s;
        proxy_buffering off;
        proxy_cache off;
    }}
    location / {{ return 404; }}
}}
''')
    run('nginx', '-t')
    run('systemctl', 'reload', 'nginx')
    print('Origin HTTPS enabled; unauthenticated requests rejected.')

def legacy_redirect(ip):
    return f'''server {{
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name {ip};
    if ($host != "{ip}") {{ return 444; }}
    location ^~ /.well-known/acme-challenge/ {{ root /var/www/codex-acme; }}
    location / {{
        if ($request_method !~ ^(GET|HEAD)$) {{ return 409; }}
        return 302 {PUBLIC}$request_uri;
    }}
}}
server {{
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name {ip};
    ssl_certificate /etc/letsencrypt/live/{ip}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{ip}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    if ($host != "{ip}") {{ return 444; }}
    if ($request_method !~ ^(GET|HEAD)$) {{ return 409; }}
    return 302 {PUBLIC}$request_uri;
}}
'''.encode()

def validate_candidate(backup, candidate):
    # Test the candidate with the existing HTTP-level configuration and every
    # enabled vhost, without changing any live nginx file or reloading nginx.
    main = Path('/etc/nginx/nginx.conf').read_text()
    include = re.compile(r'(?m)^(\s*)include\s+/etc/nginx/sites-enabled/\*\s*;')
    assert len(include.findall(main)) == 1, 'Expected one sites-enabled include; inspect nginx configuration before activation'
    candidate_path = backup / 'legacy-candidate.conf'
    atomic_write(candidate_path, candidate, 0o644)
    includes = []
    legacy = Path('/etc/nginx/sites-available/codex-web').resolve()
    matched = 0
    for site in sorted(Path('/etc/nginx/sites-enabled').iterdir()):
        if site.resolve() == legacy:
            includes.append('include ' + str(candidate_path) + ';')
            matched += 1
        else:
            # A path containing nginx syntax must not be interpolated.
            assert re.fullmatch(r'[A-Za-z0-9_./-]+', str(site)), 'Unexpected enabled vhost path'
            includes.append('include ' + str(site) + ';')
    assert matched == 1, 'Expected one enabled legacy vhost'
    testing = include.sub(lambda match: '\n'.join(match.group(1) + line for line in includes), main)
    test_path = backup / 'nginx-test.conf'
    atomic_write(test_path, testing.encode())
    run('nginx', '-t', '-c', str(test_path))

def rollback_activation(backup, metadata):
    # Restoring the pre-activation DB could discard new accounts/messages/usage.
    # The SQLite snapshot is recovery material, never an automatic rollback step.
    assert active_runs() == 0, 'Active tasks exist; defer rollback until they finish'
    atomic_write(CONFIG / 'app.env', (backup / 'app.env').read_bytes())
    atomic_write(Path('/etc/nginx/sites-available/codex-web'), (backup / 'legacy.conf').read_bytes(), metadata['legacy_mode'])
    run('nginx', '-t')
    recreate(backup, metadata)
    wait_healthy(metadata['previous_public_origin'])
    run('systemctl', 'reload', 'nginx')
    metadata['status'] = 'rolled_back'
    save_metadata(backup, metadata)
    print('Previous public origin and IP ingress restored; database retained.')

def activate():
    assert STATE.exists() and Path('/etc/letsencrypt/live/kivo-origin/fullchain.pem').exists()
    assert active_runs() == 0, 'Active tasks exist; defer activation'
    if ACTIVATION_STATE.exists():
        prior_backup, prior = activation_snapshot()
        if prior['status'] == 'active':
            wait_healthy(PUBLIC)
            print('Cloudflare ingress is already active.')
            return
        assert prior['status'] in ('rolled_back', 'preflight_failed'), 'Unfinished activation exists; run rollback before retrying'
    env = CONFIG / 'app.env'
    legacy = Path('/etc/nginx/sites-available/codex-web')
    previous_env, previous_legacy = env.read_bytes(), legacy.read_bytes()
    match = re.search(r'server_name\s+([0-9.]+);', previous_legacy.decode())
    assert match, 'Cannot identify legacy IP vhost'
    ip = str(ipaddress.ip_address(match.group(1)))
    inspected = subprocess.check_output(['docker', 'inspect', '--format',
        '{{.Image}}|{{.Config.Image}}|{{index .Config.Labels "com.docker.compose.project"}}',
        'codex-workspace-web'], text=True).strip().split('|')
    assert len(inspected) == 3 and re.fullmatch(r'sha256:[a-f0-9]{64}', inspected[0]), 'Cannot determine running backend image'
    assert re.fullmatch(r'[a-z0-9][a-z0-9_-]*', inspected[2]), 'Cannot determine backend Compose project'
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = BASE / 'backups' / ('cloudflare-activate-' + stamp + '-' + secrets.token_hex(3))
    backup.mkdir(mode=0o700)
    atomic_write(backup / 'app.env', previous_env)
    atomic_write(backup / 'legacy.conf', previous_legacy)
    atomic_write(backup / 'compose.yaml', (BASE / 'current/deploy/compose.yaml').read_bytes())
    atomic_write(backup / 'image-override.json', (json.dumps({'services': {'web': {'image': inspected[0], 'pull_policy': 'never'}}}) + '\n').encode())
    metadata = {'status': 'prepared', 'created_at': stamp, 'image_id': inspected[0],
                'image_ref': inspected[1], 'compose_project': inspected[2],
                'previous_public_origin': public_origin(previous_env), 'legacy_mode': legacy.stat().st_mode & 0o777}
    save_metadata(backup, metadata)
    atomic_write(ACTIVATION_STATE, (str(backup) + '\n').encode())
    candidate = legacy_redirect(ip)
    changed = False
    try:
        validate_candidate(backup, candidate)
        assert active_runs() == 0, 'Active tasks started; defer activation'
        with sqlite3.connect('file:/var/lib/codex-web/workspace.sqlite?mode=ro', uri=True) as db:
            with sqlite3.connect(backup / 'workspace.sqlite') as copy:
                db.backup(copy)
        os.chmod(backup / 'workspace.sqlite', 0o600)
        assert active_runs() == 0, 'Active tasks started during snapshot; defer activation'
        metadata['status'] = 'switching'
        save_metadata(backup, metadata)
        changed = True
        lines = [line for line in previous_env.decode().splitlines() if not line.startswith('PUBLIC_ORIGIN=')]
        atomic_write(env, ('\n'.join(lines) + '\nPUBLIC_ORIGIN=' + PUBLIC + '\n').encode())
        recreate(backup, metadata)
        wait_healthy(PUBLIC)
        atomic_write(legacy, candidate, metadata['legacy_mode'])
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
        metadata['status'] = 'active'
        save_metadata(backup, metadata)
        print('Public origin switched; legacy IP redirects to', PUBLIC, 'Rollback snapshot:', backup)
    except BaseException:
        if changed:
            try:
                rollback_activation(backup, metadata)
            except BaseException:
                metadata['status'] = 'rollback_failed'
                save_metadata(backup, metadata)
                print('Automatic rollback could not finish. Keep the snapshot and retry rollback after checking active tasks:', backup, file=sys.stderr)
        else:
            metadata['status'] = 'preflight_failed'
            save_metadata(backup, metadata)
        raise

def rollback():
    backup, metadata = activation_snapshot()
    rollback_activation(backup, metadata)

if __name__ == '__main__':
    assert os.geteuid() == 0, 'Run on deployment server with sudo'
    action = sys.argv[1] if len(sys.argv) == 2 else ''
    assert action in ('prepare', 'tls', 'activate', 'rollback'), 'Usage: cloudflare-origin.py prepare|tls|activate|rollback'
    {'prepare': prepare, 'tls': tls, 'activate': activate, 'rollback': rollback}[action]()
