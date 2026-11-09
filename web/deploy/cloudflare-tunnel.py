#!/usr/bin/env python3
"""Server-only loopback ingress and connector for a remotely managed tunnel.

Cloudflare tunnel creation, hostname routing and the root-only token file are
provisioned separately. This helper never installs software or changes DNS,
the business container, PUBLIC_ORIGIN, application data or existing TLS vhosts.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time
import urllib.error
import urllib.request

BASE = Path('/opt/codex-web')
CONFIG = Path('/etc/codex-web')
TOKEN = CONFIG / 'cloudflared-token'
STATE = CONFIG / 'cloudflare-tunnel-backup-path'
SITE = Path('/etc/nginx/conf.d/kivo-tunnel.conf')
UNIT = Path('/etc/systemd/system/kivo-cloudflared.service')
SERVICE = 'kivo-cloudflared.service'
BINARY = '/usr/local/bin/cloudflared'
PUBLIC = 'https://kivo.iptnet.xyz'
MARKER = '# Managed by kivo cloudflare-tunnel.py'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def run(*args):
    subprocess.run(args, check=True)


def active():
    return subprocess.run(['systemctl', 'is-active', '--quiet', SERVICE]).returncode == 0


def write(path, data, mode=0o600):
    temporary = path.with_name(path.name + '.kivo-tmp')
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def snapshot():
    if STATE.exists():
        backup = Path(STATE.read_text().strip())
        assert backup.parent == BASE / 'backups' and backup.name.startswith('cloudflare-tunnel-')
        return backup, json.loads((backup / 'files.json').read_text())
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = BASE / 'backups' / ('cloudflare-tunnel-' + stamp)
    backup.mkdir(mode=0o700)
    files = {}
    for path in (SITE, UNIT):
        assert not path.is_symlink(), 'Refusing to replace a symlink: ' + str(path)
        files[path.name] = {'exists': path.exists()}
        if path.exists():
            assert MARKER in path.read_text(), 'Refusing to replace an unmanaged file: ' + str(path)
            files[path.name]['mode'] = stat.S_IMODE(path.stat().st_mode)
            shutil.copyfile(path, backup / path.name)
    write(backup / 'files.json', json.dumps(files).encode())
    write(STATE, (str(backup) + '\n').encode())
    return backup, files


def restore(backup, files):
    for path in (SITE, UNIT):
        record = files[path.name]
        if record['exists']:
            write(path, (backup / path.name).read_bytes(), record['mode'])
        else:
            path.unlink(missing_ok=True)


def site_config():
    return (MARKER + '''
server {
    listen 127.0.0.1:18400;
    server_name origin-kivo.iptnet.xyz;
    client_max_body_size 2m;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/codex-acme;
        try_files $uri =404;
    }
    location ~ ^/(api(/|$)|healthz$) {
        if ($kivo_origin_allowed = 0) { return 403; }
        if ($kivo_client_valid = 0) { return 400; }
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
    }
    location / { return 404; }
}
''').encode()


def service_config(protocol):
    return (MARKER + f'''
[Unit]
Description=kivo Cloudflare Tunnel connector
Wants=network-online.target
After=network-online.target nginx.service

[Service]
Type=simple
DynamicUser=yes
LoadCredential=tunnel-token:{TOKEN}
ExecStart={BINARY} tunnel --no-autoupdate --protocol {protocol} --metrics 127.0.0.1:18401 --loglevel info run --token-file %d/tunnel-token
Restart=on-failure
RestartSec=5s
TimeoutStopSec=40s
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077

[Install]
WantedBy=multi-user.target
''').encode()


def fetch(url, headers=None):
    request = urllib.request.Request(url, headers={'User-Agent': 'kivo-deployment-check/1.0', **(headers or {})})
    try:
        response = OPENER.open(request, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.read(4096)


def probe_local():
    token = (CONFIG / 'cloudflare-origin-token').read_text().strip()
    assert re.fullmatch(r'[a-f0-9]{64}', token), 'Unexpected origin token format'
    target = 'http://127.0.0.1:18400/healthz'
    assert fetch(target)[0] == 403, 'Loopback ingress must reject missing origin token'
    assert fetch(target, {'X-Kivo-Origin-Token': token})[0] == 400, 'Loopback ingress must require client IP'
    status, body = fetch(target, {'X-Kivo-Origin-Token': token, 'X-Kivo-Client-IP': '192.0.2.10'})
    assert status == 200 and json.loads(body).get('ok') is True, 'Authenticated loopback health failed'
    print('PASS loopback ingress: token/IP guards and backend health')


def prepare(protocol):
    assert not active(), 'Stop the connector before changing its unit'
    assert Path(BINARY).is_file(), 'Install the official cloudflared binary first'
    assert Path('/etc/nginx/conf.d/kivo-origin-auth.conf').is_file(), 'Existing origin authorization maps are required'
    backup, files = snapshot()
    # No live reload occurs until nginx and the service unit both validate.
    try:
        write(SITE, site_config(), 0o644)
        write(UNIT, service_config(protocol), 0o644)
        run('nginx', '-t')
        run('systemd-analyze', 'verify', str(UNIT))
        run('systemctl', 'daemon-reload')
        run('systemctl', 'reload', 'nginx')
        # nginx reload returns before its new workers start listening.
        for attempt in range(20):
            try:
                probe_local()
                break
            except urllib.error.URLError:
                if attempt == 19:
                    raise
                time.sleep(0.25)
    except BaseException:
        restore(backup, files)
        run('nginx', '-t')
        run('systemctl', 'daemon-reload')
        run('systemctl', 'reload', 'nginx')
        raise
    print('Prepared connector and loopback ingress; service not started. Backup:', backup)


def start():
    assert SITE.is_file() and UNIT.is_file(), 'Run prepare first'
    assert not TOKEN.is_symlink(), 'Tunnel token must be a regular root-only file'
    info = TOKEN.stat()
    assert stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600, 'Tunnel token must be owned by root with mode 0600'
    value = TOKEN.read_text().strip()
    assert 80 <= len(value) <= 8192 and not any(char.isspace() for char in value), 'Unexpected tunnel token format'
    value = None
    probe_local()
    run('systemctl', 'enable', '--now', SERVICE)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            if fetch('http://127.0.0.1:18401/ready')[0] == 200:
                print('PASS connector has an active Cloudflare connection')
                return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(1)
    run('systemctl', 'stop', SERVICE)
    raise RuntimeError('Connector not ready; stopped it. Inspect its journal and port 7844 egress before retrying')


def verify():
    probe_local()
    assert active() and fetch('http://127.0.0.1:18401/ready')[0] == 200, 'Tunnel connector is not ready'
    status, body = fetch(PUBLIC + '/healthz')
    assert status == 200 and json.loads(body).get('ok') is True, 'Public Worker-to-tunnel health failed'
    print('PASS public Worker-to-tunnel-to-backend health')


def rollback():
    assert STATE.exists(), 'No tunnel preparation snapshot exists'
    backup, files = snapshot()
    run('systemctl', 'disable', '--now', SERVICE)
    restore(backup, files)
    run('nginx', '-t')
    run('systemctl', 'daemon-reload')
    run('systemctl', 'reload', 'nginx')
    print('Local tunnel ingress restored; credentials retained. Cloudflare DNS/routes need separate recovery.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'start', 'verify', 'rollback'))
    parser.add_argument('--protocol', choices=('auto', 'quic', 'http2'), default='auto')
    args = parser.parse_args()
    assert os.geteuid() == 0, 'Run on deployment server with sudo'
    if args.action == 'prepare':
        prepare(args.protocol)
    else:
        {'start': start, 'verify': verify, 'rollback': rollback}[args.action]()
