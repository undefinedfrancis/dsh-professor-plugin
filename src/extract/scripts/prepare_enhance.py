#!/usr/bin/env python3
"""Prepare a private, hash-locked enhancement environment. Downloads are setup-only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid
import signal
import venv


def digest(file):
    value = hashlib.sha256()
    with file.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def validate(environment, python_rel, manifest):
    if environment.is_symlink() or not (environment / python_rel).is_file():
        return False
    for repository in manifest['models']:
        for entry in repository['files']:
            target = environment / 'models' / repository['directory'] / entry['path']
            if not target.resolve().is_relative_to(environment.resolve()) or not target.is_file():
                return False
            if target.stat().st_size != entry['bytes'] or digest(target) != entry['sha256']:
                return False
    probe = subprocess.run([str(environment / python_rel), '-c',
        "import importlib.metadata as m; import docling,rapidocr,pymupdf; assert m.version('docling-slim') == '2.137.0'; assert m.version('rapidocr') == '3.10.0'"],
        stdout=sys.stderr, stderr=sys.stderr, timeout=30)
    return probe.returncode == 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--lock', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--platform', required=True)
    args = parser.parse_args()
    stage = None
    lock_handle = None
    root = Path(args.root)
    try:
        if sys.version_info[:2] != (3, 12):
            raise ValueError('automatic preparation requires the host Python 3.12 runtime')
        if args.platform == 'win32-arm64' and platform.machine().lower() not in ('amd64', 'x86_64'):
            raise ValueError('Windows ARM64 enhancement requires a verified x64 Python under emulation')
        root.mkdir(parents=True, exist_ok=True)
        lockfile = Path(args.lock)
        manifestfile = Path(args.manifest)
        manifest = json.loads(manifestfile.read_text())
        version = hashlib.sha256(lockfile.read_bytes() + manifestfile.read_bytes() + b'prepare-v1').hexdigest()[:20]
        final = root / ('env-' + version)
        python_rel = Path('Scripts/python.exe') if sys.platform == 'win32' else Path('bin/python')
        state = root / 'state.json'
        if final.is_dir() and state.is_file():
            try:
                payload = json.loads(state.read_text())
                ready = payload.get('version') == version and validate(final, python_rel, manifest)
            except Exception:
                ready = False  # Damaged cache metadata or runtime must be repairable.
            if ready:
                print(json.dumps({'ok': True, 'python': str(final / python_rel), 'artifacts': str(final / 'models')}))
                return
        guard = root / '.prepare.lock'
        for _ in range(300):
            try:
                lock_handle = os.open(guard, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                break
            except FileExistsError:
                # Recover abandoned setup after interruption, without removing a live owner's lock.
                stale = time.time() - guard.stat().st_mtime > 900
                if sys.platform != 'win32':
                    try:
                        owner = int(guard.read_text())
                        os.kill(owner, 0)
                    except ProcessLookupError:
                        stale = True
                    except (ValueError, PermissionError):
                        pass
                if stale:
                    guard.unlink(missing_ok=True)
                else:
                    time.sleep(1)
        if lock_handle is None:
            raise ValueError('another preparation is still running; retry later')
        os.write(lock_handle, str(os.getpid()).encode())
        stage = root / ('.staging-' + uuid.uuid4().hex)
        print('Preparing private Python environment and locked dependencies', file=sys.stderr)
        venv.EnvBuilder(with_pip=True).create(stage)
        interpreter = stage / python_rel
        if sys.platform == 'darwin':
            # The app's signed carrier enforces library validation, which rejects PyPI native
            # wheels. Ad-hoc sign only the copied private interpreter; never alter the carrier.
            copied = interpreter.resolve()
            if not copied.is_relative_to(stage.resolve()):
                raise ValueError('private interpreter was not copied into the cache')
            subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', str(copied)],
                           stdout=sys.stderr, stderr=sys.stderr, check=True, timeout=30)
        environment = {**os.environ, 'PIP_CACHE_DIR': str(root / 'download-cache')}
        subprocess.run([str(interpreter), '-m', 'pip', 'install', '--require-hashes', '--only-binary=:all:',
                        '--no-deps', '-r', args.lock], env=environment, stdout=sys.stderr, stderr=sys.stderr,
                       check=True, timeout=480)
        models = stage / 'models'
        for repository in manifest['models']:
            for entry in repository['files']:
                target = models / repository['directory'] / entry['path']
                target.parent.mkdir(parents=True, exist_ok=True)
                url = f"https://huggingface.co/{repository['repo']}/resolve/{repository['revision']}/{entry['path']}"
                for attempt in range(3):
                    try:
                        with urllib.request.urlopen(url, timeout=60) as response, target.open('wb') as out:
                            shutil.copyfileobj(response, out, 1024 * 1024)
                        if target.stat().st_size != entry['bytes'] or digest(target) != entry['sha256']:
                            raise ValueError('model integrity mismatch')
                        break
                    except Exception:
                        if attempt == 2:
                            raise
                        time.sleep(2 ** attempt)
        subprocess.run([str(interpreter), '-c', 'import docling,rapidocr,pymupdf; print("enhancement imports verified")'],
                       stdout=sys.stderr, stderr=sys.stderr, check=True, timeout=30)
        if not validate(stage, python_rel, manifest):
            raise ValueError('prepared resource validation failed')
        if final.is_symlink():
            raise ValueError('runtime destination must not be a symlink')
        if final.exists():
            shutil.rmtree(final)
        stage.rename(final)
        stage = None
        temporary = root / 'state.new.json'
        temporary.write_text(json.dumps({'schema_version': 1, 'version': version}))
        temporary.replace(state)
        print(json.dumps({'ok': True, 'python': str(final / python_rel), 'artifacts': str(final / 'models')}))
    except Exception as error:
        print(json.dumps({'ok': False, 'detail': f'{type(error).__name__}: preparation did not activate a runtime'}))
    finally:
        if stage is not None:
            shutil.rmtree(stage, ignore_errors=True)
        if lock_handle is not None:
            os.close(lock_handle)
            (root / '.prepare.lock').unlink(missing_ok=True)


if __name__ == '__main__':
    main()
