#!/usr/bin/env python3
"""Checks for scripts/install-shell-integration.sh in a throw-away HOME (never touches the real ~/.bashrc). Run: python3 scripts/test-shell-integration.py"""
import os, subprocess, sys, tempfile, glob, shutil, stat

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = f'{HERE}/install-shell-integration.sh'
res = []
def check(name, ok, extra=''):
    res.append(ok); print(('PASS' if ok else 'FAIL'), name, extra)

def run(rc, *args, stdin=''):
    env = dict(os.environ, CLAUDE_PET_BASHRC=rc, HOME=os.path.dirname(rc), CLAUDE_PET_LANG=os.environ.get('TEST_LANG', 'ru'))
    return subprocess.run(['bash', SCRIPT, *args], input=stdin, capture_output=True, text=True, env=env)

d = tempfile.mkdtemp(); rc = f'{d}/.bashrc'
ORIG = '# my config\nalias ll="ls -l"\nexport PATH="$HOME/bin:$PATH"\n'
open(rc, 'w').write(ORIG)

r = run(rc, stdin='n\n')
check('declining changes nothing and makes no backup', open(rc).read() == ORIG and not glob.glob(rc + '.bak-*'), r.stdout[-60:].strip())
r = run(rc, '--yes')
txt = open(rc).read()
check('--yes adds exactly one block, keeps the rest, writes a backup', txt.startswith(ORIG) and txt.count('# >>> claude-pet >>>') == 1 and txt.count('# <<< claude-pet <<<') == 1 and len(glob.glob(rc + '.bak-claude-pet-*')) == 1)
check('the backup is the original file', open(glob.glob(rc + '.bak-claude-pet-*')[0]).read() == ORIG)
check('the resulting file is valid bash', subprocess.run(['bash', '-n', rc]).returncode == 0)
check('the block points at pet-claude.py next to the script', f"'{HERE}/pet-claude.py'" in txt)
r2 = run(rc, '--yes')
check('running again is a no-op (idempotent)', open(rc).read() == txt and 'менять нечего' in r2.stdout)
r = run(rc, '--uninstall', '--yes')
check('--uninstall removes only the block', open(rc).read().rstrip('\n') == ORIG.rstrip('\n') and 'claude-pet' not in open(rc).read(), repr(open(rc).read()[-40:]))
r = run(rc, '--uninstall', '--yes')
check('uninstall when not installed says so', 'не установлена' in r.stdout)
check('--print shows the block and writes nothing', '# >>> claude-pet >>>' in run(rc, '--print').stdout and 'claude-pet' not in open(rc).read())

# a missing ~/.bashrc is created; a path with spaces and a quote works
sp = f"{d}/with space's"; os.makedirs(sp); shutil.copy(SCRIPT, sp); shutil.copy(f'{HERE}/pet-claude.py', sp)
rc2 = f'{d}/new/.bashrc'; os.makedirs(os.path.dirname(rc2))
env = dict(os.environ, CLAUDE_PET_BASHRC=rc2, HOME=os.path.dirname(rc2))
subprocess.run(['bash', f'{sp}/install-shell-integration.sh', '--yes'], capture_output=True, text=True, env=env)
check('a missing .bashrc is created', os.path.exists(rc2) and '# >>> claude-pet >>>' in open(rc2).read())
check('a path with a space and a quote stays valid bash', subprocess.run(['bash', '-n', rc2]).returncode == 0)

# behaviour of the installed function (fake `claude` and wrapper in a temp dir)
fake = f'{d}/fakebin'; os.makedirs(fake)
open(f'{fake}/claude', 'w').write('#!/bin/sh\necho "REAL claude $*"\n'); os.chmod(f'{fake}/claude', 0o755)
wrap = f'{d}/w'; os.makedirs(wrap); shutil.copy(SCRIPT, wrap)
open(f'{wrap}/pet-claude.py', 'w').write('import sys\nprint("WRAPPED", *sys.argv[1:])\n')
rc3 = f'{d}/f/.bashrc'; os.makedirs(os.path.dirname(rc3)); open(rc3, 'w').write('')
subprocess.run(['bash', f'{wrap}/install-shell-integration.sh', '--yes'], capture_output=True, env=dict(os.environ, CLAUDE_PET_BASHRC=rc3, HOME=os.path.dirname(rc3)))
def fn(cmd, env_extra=None, tty=False):
    env = {k: v for k, v in os.environ.items() if not k.startswith('CLAUDE')}
    env['PATH'] = f'{fake}:{env["PATH"]}'; env.update(env_extra or {})
    shell = f'source {rc3}; {cmd}'
    if tty: return subprocess.run(['script', '-qec', f'bash -c {subprocess.list2cmdline([shell])}', '/dev/null'], capture_output=True, text=True, env=env).stdout.replace('\r', '').strip()
    return subprocess.run(['bash', '-c', shell], capture_output=True, text=True, env=env).stdout.strip()
check('without a terminal the real claude runs (pipes, scripts)', fn('claude hi') == 'REAL claude hi')
check('on a terminal a normal call goes through the wrapper', fn('claude hello', tty=True) == 'WRAPPED claude hello')
check('--version / -p / subcommands bypass the wrapper', all(fn(c, tty=True).startswith('REAL claude') for c in ['claude --version', 'claude -p x', 'claude mcp list', 'claude --bg y']))
check('CLAUDE_PET_BYPASS=1, CLAUDECODE and PET_PTY_SOCK bypass it', all(fn('claude x', {k: '1'}, tty=True) == 'REAL claude x' for k in ['CLAUDE_PET_BYPASS', 'CLAUDECODE', 'PET_PTY_SOCK']))
check('command claude always bypasses it', fn('command claude z', tty=True) == 'REAL claude z')

# the messages follow the language: English with CLAUDE_PET_LANG=en
os.environ['TEST_LANG'] = 'en'
rc_en = f'{d}/en/.bashrc'; os.makedirs(os.path.dirname(rc_en)); open(rc_en, 'w').write(ORIG)
r_en = run(rc_en, '--uninstall')
check('English messages with CLAUDE_PET_LANG=en', 'Not installed' in r_en.stdout, r_en.stdout.strip()[:60])
os.environ['TEST_LANG'] = 'ru'

shutil.rmtree(d, ignore_errors=True)
print(f'{sum(res)}/{len(res)} passed'); sys.exit(0 if all(res) else 1)
