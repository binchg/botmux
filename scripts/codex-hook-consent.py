#!/usr/bin/env python3
"""Opt-in launcher: native CLI flag, or per-thread stdio app-server override.

Usage: codex-hook-consent.py /absolute/path/to/original/codex [original arguments]
Reads only ~/.botmux/config.json hookTrust; never logs protocol payloads.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading

FLAG = '--dangerously-bypass-hook-trust'
VALUE_OPTIONS = {'-c', '--config', '-m', '--model', '-C', '--cd', '-p', '--profile',
                 '-i', '--image', '-s', '--sandbox', '-a', '--ask-for-approval',
                 '--local-provider', '--enable', '--disable', '--add-dir', '--remote',
                 '--permission-mode', '--session-id'}
COMMANDS = {'exec', 'e', 'resume', 'fork', 'review', 'app-server', 'login', 'logout',
            'mcp', 'mcp-server', 'completion', 'update', 'doctor', 'sandbox', 'debug',
            'apply', 'a', 'features', 'help', 'cloud', 'feedback', 'migrate', 'plugin',
            'plugins', 'remote-control'}


def policy():
    try:
        value = json.loads((Path.home() / '.botmux/config.json').read_text()).get('hookTrust')
        return value if value in ('always', 'review') else None
    except (OSError, ValueError, AttributeError):
        return None


def command_index(args):
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == '--':
            return None
        if arg in VALUE_OPTIONS:
            i += 2
            continue
        if not arg.startswith('-'):
            return i if arg in COMMANDS else None
        i += 1
    return None


def cli_args(args, consent):
    boundary = args.index('--') if '--' in args else len(args)
    args = [arg for arg in args[:boundary] if arg != FLAG] + args[boundary:]
    if consent != 'always':
        return args
    index = command_index(args)
    command = args[index] if index is not None else None
    if command in ('exec', 'e', 'resume', 'fork'):
        return args[:index + 1] + [FLAG] + args[index + 1:]
    if command == 'review':
        return args[:index] + ['exec', 'review', FLAG] + args[index + 1:]
    if command is None:
        return [FLAG] + args
    # Non-agent maintenance commands must keep their original parser/semantics.
    return args


def thread_override(line):
    consent = policy()  # existing wrapper processes also observe policy changes
    if consent is None:
        return line
    try:
        message = json.loads(line)
        if message.get('method') not in ('thread/start', 'thread/resume', 'thread/fork'):
            return line
        params = message.setdefault('params', {})
        config = params.get('config')
        if config is not None and not isinstance(config, dict):
            return line  # let native validation reject malformed requests
        params['config'] = {**(config or {}), 'bypass_hook_trust': consent == 'always'}
        return (json.dumps(message, ensure_ascii=False) + '\n').encode()
    except (ValueError, AttributeError, TypeError):
        return line


def main():
    if len(sys.argv) < 2:
        raise SystemExit('original executable path required')
    executable, args = sys.argv[1], sys.argv[2:]
    consent = policy()
    index = command_index(args)
    command = args[index] if index is not None else None
    if consent is None or command != 'app-server' or any(arg in args for arg in ('-h', '--help', 'generate-json-schema', 'generate-ts')):
        os.execv(executable, [executable, *(cli_args(args, consent) if consent else args)])
    listen = 'stdio://'
    for i, arg in enumerate(args):
        if arg == '--listen' and i + 1 < len(args):
            listen = args[i + 1]
        elif arg.startswith('--listen='):
            listen = arg.partition('=')[2]
    if listen != 'stdio://':
        print('Hook consent launcher: non-stdio transport requires client thread config bypass_hook_trust.', file=sys.stderr)
        os.execv(executable, [executable, *args])
    child = subprocess.Popen([executable, *args], stdin=subprocess.PIPE)

    def forward(signum, _frame):
        if child.poll() is None:
            child.send_signal(signum)

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, forward)

    def pump():
        try:
            for line in sys.stdin.buffer:
                child.stdin.write(thread_override(line))
                child.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            try:
                child.stdin.close()
            except OSError:
                pass

    threading.Thread(target=pump, daemon=True).start()
    status = child.wait()
    return status if status >= 0 else 128 - status


if __name__ == '__main__':
    sys.exit(main())
