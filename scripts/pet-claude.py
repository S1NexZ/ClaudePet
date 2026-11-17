#!/usr/bin/env python3
"""pet-claude: run a command (default: claude) as ONE process on a PTY and share it.

The visible terminal and any number of unix-socket clients all talk to the same PTY:
  - terminal keystrokes and socket bytes are both written to the PTY master (the program cannot tell them apart);
  - everything the program prints goes to the terminal and to every connected socket client.
Socket clients are optional and disposable: disconnecting one never touches the child.

usage: pet-claude.py [--sock PATH] [--] [command args...]      (default command: claude)
The socket is ~/.claude-pet/pty/<wrapper pid>.sock (dir 0700, socket 0600) and is exported to the child as PET_PTY_SOCK.
Stage 1 only: not wired to the pet UI, hooks or daemon.
"""
import errno, fcntl, os, pty, select, shutil, signal, socket, stat, struct, sys, termios, tty

MAX_CLIENT_BACKLOG = 1 << 20  # drop a socket client that stops reading instead of stalling the terminal


def parse_args(argv):
    sock, rest = None, argv[1:]
    if rest[:1] == ['--sock'] and len(rest) >= 2:
        sock, rest = rest[1], rest[2:]
    if rest[:1] == ['--']:
        rest = rest[1:]
    return sock, (rest or ['claude'])


def resolve_command(cmd):
    """`claude` is often only on PATH in interactive shells (~/.local/bin is added by .bashrc/.profile): fall back to the usual install places."""
    if cmd[0] == 'claude' and not shutil.which('claude'):
        for p in ('~/.local/bin/claude', '~/.claude/local/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude'):
            p = os.path.expanduser(p)
            if os.path.isfile(p) and os.access(p, os.X_OK):
                return [p] + cmd[1:]
    return cmd


def default_sock_path():
    d = os.path.join(os.path.expanduser('~'), '.claude-pet', 'pty')
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    return os.path.join(d, f'{os.getpid()}.sock')


def bind_socket(path):
    if os.path.exists(path):  # stale leftover of a crashed wrapper, but never steal a live one
        probe = socket.socket(socket.AF_UNIX)
        try:
            probe.connect(path)
            raise SystemExit(f'pet-claude: {path} is in use')
        except (ConnectionRefusedError, FileNotFoundError):
            os.unlink(path)
        finally:
            probe.close()
    old = os.umask(0o177)  # socket is created 0600: no window where others could connect
    try:
        srv = socket.socket(socket.AF_UNIX)
        srv.bind(path)
    finally:
        os.umask(old)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    srv.listen(8)
    srv.setblocking(False)
    return srv


def copy_winsize(src_fd, dst_fd):
    try:
        fcntl.ioctl(dst_fd, termios.TIOCSWINSZ, fcntl.ioctl(src_fd, termios.TIOCGWINSZ, b'\0' * 8))
    except OSError:
        pass  # not a tty / already gone; the kernel sends SIGWINCH to the child itself on a real change


def main():
    sock_path, cmd = parse_args(sys.argv)
    cmd = resolve_command(cmd)
    sock_path = sock_path or default_sock_path()
    srv = bind_socket(sock_path)
    os.environ['PET_PTY_SOCK'] = sock_path

    pid, mfd = pty.fork()
    if pid == 0:
        try:
            os.execvp(cmd[0], cmd)
        except OSError as e:
            sys.stderr.write(f'pet-claude: cannot run {cmd[0]}: {e.strerror}\n')
            os._exit(127)

    stdin_tty = os.isatty(0)
    old_attrs = termios.tcgetattr(0) if stdin_tty else None
    if stdin_tty:
        tty.setraw(0)
    # signals are only recorded here and handled in the loop (safe), woken through a pipe
    wr, ww = os.pipe()
    for fd in (wr, ww):
        os.set_blocking(fd, False)
    signal.set_wakeup_fd(ww)
    got = set()
    for s in (signal.SIGWINCH, signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(s, lambda n, f: got.add(n))
    copy_winsize(1, mfd)

    clients, backlog = [], {}
    stdin_open, status, terminating = True, None, False

    def drop(c):
        if c in clients:
            clients.remove(c)
        backlog.pop(c, None)
        try:
            c.close()
        except OSError:
            pass

    def send_all(data):
        for c in list(clients):
            try:
                c.send(backlog.pop(c, b'') + data)
            except BlockingIOError:
                buf = backlog.get(c, b'') + data
                if len(buf) > MAX_CLIENT_BACKLOG:
                    drop(c)
                else:
                    backlog[c] = buf
            except OSError:
                drop(c)

    try:
        while True:
            watch = [mfd, srv, wr] + clients + ([0] if stdin_open else [])
            try:
                r, _, _ = select.select(watch, [], [], 0.5)
            except InterruptedError:
                continue
            if wr in r:
                try:
                    os.read(wr, 1024)
                except BlockingIOError:
                    pass
            if signal.SIGWINCH in got:
                got.discard(signal.SIGWINCH)
                copy_winsize(1, mfd)
            for s in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
                if s in got:  # asked from outside (a typed Ctrl+C never reaches us: raw mode sends it to the child)
                    got.discard(s)
                    terminating = True
                    try:
                        os.kill(pid, signal.SIGHUP if s == signal.SIGHUP else signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            if 0 in r:
                try:
                    d = os.read(0, 4096)
                except OSError:
                    d = b''
                if d:
                    os.write(mfd, d)
                else:
                    stdin_open = False
                    if stdin_tty:  # the terminal itself is gone: nobody to show the session to
                        try:
                            os.kill(pid, signal.SIGHUP)
                        except ProcessLookupError:
                            pass
            if mfd in r:
                try:
                    d = os.read(mfd, 65536)
                except OSError as e:
                    d = b'' if e.errno == errno.EIO else None  # EIO: the child closed its side
                    if d is None:
                        raise
                if not d:
                    break
                try:
                    os.write(1, d)
                except OSError:
                    pass  # terminal output closed; keep the session alive for socket clients
                send_all(d)
            if srv in r:
                try:
                    c, _ = srv.accept()
                    c.setblocking(False)
                    clients.append(c)
                except OSError:
                    pass
            for c in list(clients):
                if c in r:
                    try:
                        d = c.recv(65536)
                    except BlockingIOError:
                        continue
                    except OSError:
                        d = b''
                    if d:
                        os.write(mfd, d)
                    else:
                        drop(c)  # a client leaving never affects the child
            if terminating:
                try:
                    done, st = os.waitpid(pid, os.WNOHANG)
                    if done:
                        status = st
                        break
                except ChildProcessError:
                    break
    finally:
        signal.set_wakeup_fd(-1)
        if stdin_tty:
            try:
                termios.tcsetattr(0, termios.TCSANOW, old_attrs)
            except (termios.error, OSError):
                pass  # terminal already gone
        for c in list(clients):
            drop(c)
        srv.close()
        try:
            os.unlink(sock_path)
        except FileNotFoundError:
            pass
        os.close(mfd)
    if status is None:
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            status = 0
    code = os.waitstatus_to_exitcode(status)
    sys.exit(128 - code if code < 0 else code)


if __name__ == '__main__':
    main()
