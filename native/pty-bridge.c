// pty-bridge: runs one command inside a Unix pseudo terminal and relays it over
// this process's standard streams. The macOS twin of conpty-bridge.cs, with the
// same protocol, so ptyhost.js treats both alike.
//
//   pty-bridge <cols> <rows> <workdir> <command line>
//
// stdout  raw terminal output (VT sequences, UTF-8), exactly as the pty emits it
// stdin   frames: [type:1][length:4, little endian][payload]
//           0 = input bytes, 1 = resize (cols:int16, rows:int16), 2 = close
// stderr  "PID <n>" once the command has started, "ERR <text>" on failure
// exit    the command's exit code (90+ for bridge failures)
//
// The command line runs as `exec <command>` in the user's login shell, so PATH
// matches a Terminal window even when the app was started from Finder.
// Compiled on first use with the cc that ships with the Xcode command line tools.

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <util.h>

static int fail(const char *msg, int code) {
  fprintf(stderr, "ERR %s\n", msg);
  fflush(stderr);
  return code;
}

static int write_all(int fd, const char *buf, size_t len) {
  while (len > 0) {
    ssize_t n = write(fd, buf, len);
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN) { struct pollfd p = { fd, POLLOUT, 0 }; poll(&p, 1, 1000); continue; }
      return -1;
    }
    buf += n;
    len -= (size_t)n;
  }
  return 0;
}

static int32_t le32(const unsigned char *p) { return (int32_t)((uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24); }
static int16_t le16(const unsigned char *p) { return (int16_t)((uint16_t)p[0] | (uint16_t)p[1] << 8); }

static int64_t now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

// Copies whatever the pty has right now to stdout. Returns -1 once it is closed.
static int drain(int master) {
  char buf[16384];
  for (;;) {
    ssize_t n = read(master, buf, sizeof buf);
    if (n > 0) { if (write_all(STDOUT_FILENO, buf, (size_t)n) < 0) return -1; continue; }
    if (n < 0 && (errno == EAGAIN || errno == EINTR)) return 0;
    return -1; // EIO: every process on the terminal has gone
  }
}

int main(int argc, char **argv) {
  if (argc != 5) return fail("usage: pty-bridge <cols> <rows> <workdir> <command line>", 91);
  struct winsize ws = { (unsigned short)atoi(argv[2]), (unsigned short)atoi(argv[1]), 0, 0 };
  if (ws.ws_col == 0 || ws.ws_row == 0) return fail("bad size", 91);

  const char *shell = getenv("SHELL");
  if (!shell || !*shell) shell = "/bin/zsh";
  size_t clen = strlen(argv[4]) + 6;
  char *cmd = malloc(clen);
  if (!cmd) return fail("out of memory", 92);
  snprintf(cmd, clen, "exec %s", argv[4]);

  signal(SIGPIPE, SIG_IGN);
  int master;
  pid_t pid = forkpty(&master, NULL, NULL, &ws);
  if (pid < 0) return fail("forkpty failed", 93);
  if (pid == 0) {
    if (chdir(argv[3]) != 0) { fprintf(stderr, "ERR chdir %s: %s\n", argv[3], strerror(errno)); _exit(94); }
    setenv("TERM", "xterm-256color", 1);
    setenv("COLORTERM", "truecolor", 1);
    if (!getenv("LANG")) setenv("LANG", "en_US.UTF-8", 1);
    execl(shell, shell, "-l", "-c", cmd, (char *)NULL);
    fprintf(stderr, "ERR exec %s: %s\n", shell, strerror(errno));
    _exit(96);
  }
  free(cmd);
  fprintf(stderr, "PID %d\n", (int)pid);
  fflush(stderr);
  fcntl(master, F_SETFL, fcntl(master, F_GETFL) | O_NONBLOCK);

  // Frames from Node, gathered until whole.
  size_t cap = 65536, have = 0;
  unsigned char *in = malloc(cap);
  if (!in) return fail("out of memory", 92);
  int closing = 0, status = 0, reaped = 0, stdin_open = 1;
  int64_t close_at = 0;

  for (;;) {
    if (!reaped && waitpid(pid, &status, WNOHANG) == pid) reaped = 1;
    if (closing && !reaped && now_ms() - close_at > 5000) kill(-pid, SIGKILL);

    struct pollfd fds[2] = { { master, POLLIN, 0 }, { STDIN_FILENO, POLLIN, 0 } };
    int nf = stdin_open && !closing ? 2 : 1;
    int r = poll(fds, (nfds_t)nf, reaped ? 50 : 200);
    if (r < 0 && errno != EINTR) break;

    if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
      if (drain(master) < 0) break;
    } else if (reaped) {
      break; // child gone and nothing left to read
    }

    if (nf == 2 && (fds[1].revents & (POLLIN | POLLHUP | POLLERR))) {
      if (have == cap) { cap *= 2; unsigned char *g = realloc(in, cap); if (!g) break; in = g; }
      ssize_t n = read(STDIN_FILENO, in + have, cap - have);
      if (n <= 0) {
        if (n < 0 && errno == EINTR) continue;
        // A closed stdin means Node is gone, which also ends the session.
        stdin_open = 0;
        closing = 1; close_at = now_ms(); kill(-pid, SIGHUP);
        continue;
      }
      have += (size_t)n;
      size_t off = 0;
      while (have - off >= 5) {
        int32_t len = le32(in + off + 1);
        if (len < 0 || len > (1 << 20)) { closing = 1; break; }
        if (have - off < 5 + (size_t)len) {
          size_t need = 5 + (size_t)len;
          if (need > cap) { unsigned char *g = realloc(in, need); if (!g) { closing = 1; break; } in = g; cap = need; }
          break;
        }
        unsigned char type = in[off];
        unsigned char *p = in + off + 5;
        if (type == 0) write_all(master, (char *)p, (size_t)len);
        else if (type == 1 && len == 4) {
          int16_t c = le16(p), rr = le16(p + 2);
          if (c > 0 && rr > 0) {
            struct winsize w = { (unsigned short)rr, (unsigned short)c, 0, 0 };
            ioctl(master, TIOCSWINSZ, &w);
          }
        } else if (type == 2) { closing = 1; }
        off += 5 + (size_t)len;
      }
      if (closing && !close_at) { close_at = now_ms(); kill(-pid, SIGHUP); }
      memmove(in, in + off, have - off);
      have -= off;
    }
  }

  if (!reaped) {
    kill(-pid, SIGHUP);
    for (int i = 0; i < 50 && waitpid(pid, &status, WNOHANG) != pid; i++) usleep(100000);
    if (waitpid(pid, &status, WNOHANG) == 0) { kill(-pid, SIGKILL); waitpid(pid, &status, 0); }
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 0;
}
