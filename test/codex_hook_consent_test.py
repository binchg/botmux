import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/codex-hook-consent.py'
spec = importlib.util.spec_from_file_location('consent', SCRIPT)
consent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(consent)


class HookConsent(unittest.TestCase):
    def test_native_arguments_preserve_prompt_and_maintenance(self):
        flag = consent.FLAG
        for command in ('exec', 'resume', 'fork'):
            self.assertEqual(consent.cli_args(['-C', 'exec', command, '--', flag], 'always'),
                             ['-C', 'exec', command, flag, '--', flag])
        self.assertEqual(consent.cli_args(['update', 'check'], 'always'), ['update', 'check'])
        self.assertEqual(consent.cli_args(['review', '--uncommitted'], 'always'), ['exec', 'review', flag, '--uncommitted'])
        self.assertEqual(consent.cli_args([flag, '--', flag], 'review'), ['--', flag])

    def test_thread_override_and_revoke_preserve_other_configuration(self):
        source = {'id': 9, 'method': 'thread/resume', 'params': {'threadId': 'same', 'config': {'model': 'unchanged', 'bypass_hook_trust': False}}}
        for policy in ('always', 'review', None):
            with patch.object(consent, 'policy', return_value=policy):
                out = json.loads(consent.thread_override(json.dumps(source).encode()))
            self.assertEqual(out['id'], 9)
            self.assertEqual(out['params']['threadId'], 'same')
            self.assertEqual(out['params']['config']['model'], 'unchanged')
            self.assertEqual(out['params']['config']['bypass_hook_trust'], policy == 'always')
        for line in (b'not-json\n', b'{"method":"turn/start","params":{"threadId":"x"}}\n', b'{"id":1,"result":{"blocked":true}}\n'):
            with patch.object(consent, 'policy', return_value='always'):
                self.assertEqual(consent.thread_override(line), line)

    def test_stdio_subprocess_preserves_protocol_and_exit_code(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            (home / '.botmux').mkdir()
            (home / '.botmux/config.json').write_text('{"hookTrust":"always"}')
            original = home / 'native'
            original.write_text('#!/usr/bin/env python3\nimport sys\nfor line in sys.stdin: print(line,end="",flush=True)\nsys.exit(7)\n')
            original.chmod(0o700)
            request = b'{"id":1,"method":"thread/start","params":{"cwd":"/sample"}}\n'
            result = subprocess.run(['python3', str(SCRIPT), str(original), 'app-server', '--listen', 'stdio://'],
                                    input=request, capture_output=True, env={**os.environ, 'HOME': d}, timeout=5)
            self.assertEqual(result.returncode, 7)
            self.assertEqual(result.stderr, b'')
            self.assertEqual(json.loads(result.stdout)['params']['config'], {'bypass_hook_trust': True})


if __name__ == '__main__':
    unittest.main()
