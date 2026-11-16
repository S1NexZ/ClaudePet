#!/usr/bin/env python3
"""Stage 1 checks for pet-claude.py using a harmless child (no Claude, no usage). Run: python3 scripts/test-pet-claude.py"""
import fcntl, os, pty, select, signal, socket, stat, struct, sys, tempfile, termios, time

HERE = os.path.dirname(os.path.abspath(__file__))
CHILD = r'''
import os, signal, sys, struct, fcntl, termios, time
def size():
    h, w = struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0'*8))[:2]; return f'{w}x{h}'
signal.signal(signal.SIGWINCH, lambda *a: print('SIZE', size(), flush=True))
signal.signal(signal.SIGINT, lambda *a: print('GOT-SIGINT', flush=True))
print('READY', os.getpid(), size(), os.environ.get('PET_PTY_SOCK', '-'), flush=True)
for line in sys.stdin:
    line = line.strip()
    if line == 'quit': sys.exit(7)
    print('ECHO', line, flush=True)
'''
res = []
def check(name, ok, extra=''):
    res.append(ok); print(('PASS' if ok else 'FAIL'), name, extra)

class Run:
    def __init__(self, sockpath):
        self.sock = sockpath
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execvp('python3', ['python3', f'{HERE}/pet-claude.py', '--sock', sockpath, '--', 'python3', '-c', CHILD])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
        self.term = b''
    def pump(self, t=0.6, c=None, until=None):
        end = time.time() + t; got = b''
        while time.time() < end:
            fds = [self.fd] + ([c] if c else [])
            r, _, _ = select.select(fds, [], [], 0.1)
            if self.fd in r:
                try: d = os.read(self.fd, 65536)
                except OSError: d = b''
                self.term += d
            if c in r:
                try: got += c.recv(65536)
                except OSError: pass
            if until and (until in self.term or until in got): break
        return got
    def connect(self):
        c = socket.socket(socket.AF_UNIX); c.connect(self.sock); c.setblocking(False); return c
    def wait(self, t=5):
        end = time.time() + t
        while time.time() < end:
            p, st = os.waitpid(self.pid, os.WNOHANG)
            if p: return os.waitstatus_to_exitcode(st)
            self.pump(0.1)
        return None

def child_pid(run):
    return int(run.term.split(b'READY ')[1].split()[0])
def alive(pid):
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False

d = tempfile.mkdtemp(prefix='petpty-'); os.chmod(d, 0o700)
sp = f'{d}/t.sock'
r = Run(sp); r.pump(1.5, until=b'READY')
cp = child_pid(r)
check('child starts as one process, PET_PTY_SOCK exported', f'READY {cp} 100x30 {sp}'.encode() in r.term)
check('socket mode is 0600', stat.S_IMODE(os.stat(sp).st_mode) == 0o600, oct(stat.S_IMODE(os.stat(sp).st_mode)))

c = r.connect()
out = (c.send(b'hello-from-socket\n'), r.pump(1, c, until=b'ECHO hello-from-socket'))[1]
check('socket input reaches the child; output seen by terminal and client', b'ECHO hello-from-socket' in r.term and b'ECHO hello-from-socket' in out)
os.write(r.fd, b'hello-from-terminal\n'); out = r.pump(1, c, until=b'ECHO hello-from-terminal')
check('terminal input reaches the same child; client sees it too', b'ECHO hello-from-terminal' in out)

fcntl.ioctl(r.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 140, 0, 0)); os.kill(r.pid, signal.SIGWINCH); r.pump(1, until=b'SIZE 140x50')
check('terminal resize reaches the child PTY (SIGWINCH + size)', b'SIZE 140x50' in r.term)

os.write(r.fd, b'\x03'); r.pump(1, until=b'GOT-SIGINT')
check('Ctrl+C is delivered to the child as SIGINT, wrapper and child survive', b'GOT-SIGINT' in r.term and alive(cp) and alive(r.pid))

c.close(); r.pump(0.5)
check('socket client disconnect does not kill the child', alive(cp))
c2 = r.connect(); c2.send(b'again\n'); out = r.pump(1, c2, until=b'ECHO again')
check('a new client can reconnect to the same live child', b'ECHO again' in out)
c2.close()

os.write(r.fd, b'quit\n'); code = r.wait()
check('child exit code is propagated, wrapper exits', code == 7, f'code={code}')
check('socket file removed after exit', not os.path.exists(sp))

sp2 = f'{d}/t2.sock'; r2 = Run(sp2); r2.pump(1.5, until=b'READY'); cp2 = child_pid(r2)
os.kill(r2.pid, signal.SIGTERM); code = r2.wait(); time.sleep(0.3)
check('SIGTERM to wrapper terminates child, cleans socket', code is not None and not alive(cp2) and not os.path.exists(sp2), f'code={code}')

sp3 = f'{d}/t3.sock'; r3 = Run(sp3); r3.pump(1.5, until=b'READY'); cp3 = child_pid(r3)
os.close(r3.fd); time.sleep(1.5)   # the user closes the terminal window
check('closing the terminal hangs up the child (no orphan), socket cleaned', not alive(cp3) and not os.path.exists(sp3))
try: os.waitpid(r3.pid, os.WNOHANG)
except ChildProcessError: pass

import importlib.util
spec = importlib.util.spec_from_file_location('petclaude', f'{HERE}/pet-claude.py'); pc = importlib.util.module_from_spec(spec); spec.loader.exec_module(pc)
_home, _path = os.environ.get('HOME'), os.environ.get('PATH')
fake = tempfile.mkdtemp(); os.makedirs(f'{fake}/.local/bin'); open(f'{fake}/.local/bin/claude', 'w').write('#!/bin/sh\n'); os.chmod(f'{fake}/.local/bin/claude', 0o755)
os.environ['HOME'], os.environ['PATH'] = fake, '/usr/bin:/bin'
check('claude missing from PATH is found in ~/.local/bin', pc.resolve_command(['claude', '-x']) == [f'{fake}/.local/bin/claude', '-x'])
check('other commands are left alone', pc.resolve_command(['python3', 'a']) == ['python3', 'a'])
os.environ['HOME'], os.environ['PATH'] = _home, _path

print(f'{sum(res)}/{len(res)} passed'); sys.exit(0 if all(res) else 1)
