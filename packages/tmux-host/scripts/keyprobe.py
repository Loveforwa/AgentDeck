#!/usr/bin/env python3
# 按键探针：在 tmux 窗格里运行，把收到的每段原始字节（带收到的时间）以十六进制追加写到日志文件，
# 用来对比“外层终端发出的字节”和“agent 实际收到的字节”。
#
# 用法：keyprobe.py <日志文件> [模式...]
#   模式：paste（bracketed paste）、mouse（SGR 鼠标上报）、appcursor（应用光标键）、
#         focus（焦点事件）、alt（备用屏）、mok（申请 modifyOtherKeys 2）、
#         kitty（申请 kitty 键盘协议 1）、history（先打 200 行，制造可回滚的历史）
# 不依赖第三方包；用 python3 -I 运行。
import os
import sys
import termios
import time
import tty

MODES = {
    'paste': ('\x1b[?2004h', '\x1b[?2004l'),
    'mouse': ('\x1b[?1002h\x1b[?1006h', '\x1b[?1006l\x1b[?1002l'),
    'appcursor': ('\x1b[?1h', '\x1b[?1l'),
    'focus': ('\x1b[?1004h', '\x1b[?1004l'),
    'alt': ('\x1b[?1049h', '\x1b[?1049l'),
    'mok': ('\x1b[>4;2m', '\x1b[>4;0m'),
    'kitty': ('\x1b[>1u', '\x1b[<u'),
}


def main() -> None:
    log_path = sys.argv[1]
    modes = sys.argv[2:]
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    tty.setraw(fd)
    out = sys.stdout
    try:
        if 'history' in modes:
            for i in range(200):
                out.write(f'history line {i}\r\n')
        for m in modes:
            if m in MODES:
                out.write(MODES[m][0])
        out.write('PROBE READY ' + ' '.join(modes) + '\r\n')
        out.flush()
        with open(log_path, 'a', buffering=1) as log:
            log.write('ready\n')
            while True:
                data = os.read(fd, 4096)
                if not data:
                    break
                log.write(f'{time.time():.6f} {data.hex()}\n')
                # 收到 0x04（C-d）单独一段时退出。
                if data == b'\x04':
                    break
    finally:
        for m in reversed(modes):
            if m in MODES:
                out.write(MODES[m][1])
        out.flush()
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


if __name__ == '__main__':
    main()
