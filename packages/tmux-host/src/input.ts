// 判断 write() 收到的字节是不是“用户输入”。
// 终端窗口经同一条路写回的还有 xterm 对查询的回答（DA、OSC 10/11、XTVERSION）、焦点事件和鼠标上报，
// 这些不能算 terminal.input，否则一聚焦、一 attach 状态机就以为用户回答了（docs/decisions.md 的兜底规则）。

/** 终端对查询的回答和焦点事件。可以连在一起出现（一次写入多条）。 */
const REPORT = new RegExp(
  [
    '\\x1b\\[[IO]', // 焦点
    '\\x1b\\[[?>=]?[\\d;]*c', // DA1 / DA2 / DA3
    '\\x1b\\[\\d+;\\d+R', // 光标位置
    '\\x1b\\[\\?[\\d;]*\\$y', // DECRPM
    '\\x1b\\[\\?\\d+;\\d+n', // 主题（997）、状态报告
    '\\x1b\\[\\d*n', // DSR
    '\\x1b\\][\\d;]*[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC 回答（10/11/4/52…）
    '\\x1bP[^\\x1b]*\\x1b\\\\', // DCS 回答（XTVERSION、DECRQSS）
    '\\x1b\\[\\d+;\\d+;\\d+t', // 窗口大小报告
  ].join('|'),
  'g',
);

/** SGR（1006）和 X10 鼠标上报。 */
const MOUSE = /\x1b\[<(\d+);\d+;\d+[Mm]|\x1b\[M[\s\S]{3}/g;

export interface InputKind {
  /** 算不算用户输入（发 terminal.input）。 */
  user: boolean;
  /** 里面有鼠标事件：tmux 可能因此进了回滚（copy-mode）。 */
  mouse: boolean;
  /** 有会被 copy-mode 的 Any 吞掉的按键（见 AGENTS.md 问题 9）。 */
  keys: boolean;
}

/** 回滚里要交给 copy-mode 自己处理、不应先退出回滚的键：PageUp、PageDown。 */
const COPY_MODE_KEYS = /^(?:\x1b\[5~|\x1b\[6~)+$/;

export function classifyInput(data: string): InputKind {
  let mouse = false;
  let userMouse = false;
  const withoutMouse = data.replace(MOUSE, (m, button: string | undefined) => {
    mouse = true;
    // 点击算用户输入（codex 里点选项）；滚轮（64–67）和移动（+32）不算。
    const b = button === undefined ? m.charCodeAt(3) - 32 : Number(button);
    if (b < 32) userMouse = true;
    return '';
  });
  const rest = withoutMouse.replace(REPORT, '');
  return {
    user: rest.length > 0 || userMouse,
    mouse,
    keys: rest.length > 0 && !COPY_MODE_KEYS.test(rest),
  };
}
