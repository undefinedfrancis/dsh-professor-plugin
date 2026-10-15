"""Unit-test interrupted preparation recovery with fake installers, never downloads."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('prepare', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as folder:
    root = Path(folder) / 'cache'
    root.mkdir()
    lock = Path(folder) / 'requirements.lock'
    lock.write_text('locked-test')
    manifest = Path(folder) / 'models.json'
    manifest.write_text('{"models":[]}')
    version = module.hashlib.sha256(lock.read_bytes() + manifest.read_bytes() + b'prepare-v1').hexdigest()[:20]
    (root / ('env-' + version)).mkdir()
    (root / 'state.json').write_text('{corrupt')
    (root / '.prepare.lock').write_text('99999999')
    def fake_create(self, destination):
        (destination / 'bin').mkdir(parents=True)
        (destination / 'bin/python').write_text('fake-private-python')
    stream = io.StringIO()
    with patch.object(sys, 'argv', ['prepare', '--root', str(root), '--lock', str(lock), '--manifest', str(manifest), '--platform', 'linux-x64']), \
         patch.object(sys, 'version_info', (3,12,0)), patch.object(sys, 'platform', 'linux'), \
         patch.object(module.venv.EnvBuilder, 'create', fake_create), \
         patch.object(module.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), \
         contextlib.redirect_stdout(stream):
        module.main()
    result = json.loads(stream.getvalue())
    assert result['ok'], result
    assert not (root / '.prepare.lock').exists()
    assert json.loads((root / 'state.json').read_text())['version'] == version
    print('corrupt state and abandoned setup recover without network')
