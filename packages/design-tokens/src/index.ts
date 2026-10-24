// AgentDeck 的样子只在这里定。tokens.css 由 scripts/gen-css.ts 从这个文件生成，不要手改 tokens.css。
// 方向：暖灰加墨黑；颜色只用来表达状态（MVP v2 · V2 红绿灯）：运行中绿、等你黄（attention）、出错红，其他地方不用彩色；不用渐变、发光、毛玻璃。
// 例外：拖动时临时出现的对齐线用蓝色（guide，MVP v2 · V3，照设计画布画板 11）。

/** 一套主题里所有随明暗变化的值。键名转成 kebab-case 就是 CSS 变量名：lineStrong → --line-strong。 */
export interface ThemeColors {
  /** 白板和窗口外面的底色 */
  ground: string;
  /** 窗口、面板、输入框 */
  surface: string;
  /** 浮起来的东西：菜单、弹出框、对话框 */
  raised: string;
  /** 悬停和键盘选中的行 */
  hover: string;
  /** 正文；主要按钮的底色 */
  ink: string;
  /** 主要按钮悬停 */
  inkHover: string;
  /** 墨色底上的字 */
  onInk: string;
  /** 次要文字、快捷键提示 */
  muted: string;
  /** 1px 分隔线、窗口外框 */
  line: string;
  /** 按钮、输入框、单选框的边 */
  lineStrong: string;
  /** 菜单里的分隔线 */
  lineSubtle: string;
  /** 只用于“需要你处理”：等批准、等你回复、需要确认的风险。黄色系，也是 Waiting 的文字色 */
  attention: string;
  /** attention 底上的字 */
  onAttention: string;
  /** 状态灯（MVP v2 · V2）：运行中。也用作 Running 的文字色 */
  statusRunning: string;
  /** 状态灯：等你（点和窗口边框用；文字用 attention） */
  statusWaiting: string;
  /** 状态灯：出错。也用作 Error 的文字色 */
  statusError: string;
  /** 白板的对齐线和间距、尺寸标注（MVP v2 · V3）。只在拖动、改大小时出现，不表示状态。也是标注数字的文字色 */
  guide: string;
  /** 键盘焦点环 */
  focus: string;
  /** 对话框背后的遮罩 */
  scrim: string;
  /** 只给浮起来的东西：菜单、弹出框、对话框、提示、拖动中的窗口 */
  shadowFloat: string;
  /** 左下角的小吉祥物 Clawd 的身体。不是 attention，不表示任何状态 */
  mascot: string;
  /** Clawd 的眼睛，明暗主题都是深色（橙色身体上要看得见） */
  mascotEye: string;
  /** Clawd 手里的东西（杠铃、电脑、碗），跟着底色走 */
  mascotProp: string;
  /** Clawd 碗里的饭 */
  mascotFood: string;
}

export const light: ThemeColors = {
  ground: '#F7F7F5',
  surface: '#FFFFFF',
  raised: '#FFFFFF',
  hover: '#EDEDEA',
  ink: '#1A1A1A',
  inkHover: '#383836',
  onInk: '#FFFFFF',
  muted: '#6B6B6B',
  line: '#E3E3E0',
  lineStrong: '#D6D6D2',
  lineSubtle: '#EEEEEB',
  attention: '#B45309',
  onAttention: '#FFFFFF',
  statusRunning: '#1A7F37',
  statusWaiting: '#BF8700',
  statusError: '#CF222E',
  guide: '#2563EB',
  focus: '#1A1A1A',
  scrim: 'rgba(26, 26, 26, 0.18)',
  shadowFloat: '0 8px 24px rgba(0, 0, 0, 0.08)',
  mascot: '#D97757',
  mascotEye: '#1A1A1A',
  mascotProp: '#383836',
  mascotFood: '#D9A520',
};

// 暖深灰，不是纯黑。深色下阴影看不出来，浮起来的东西靠 raised 比 surface 亮一档来区分。
export const dark: ThemeColors = {
  ground: '#161615',
  surface: '#1E1E1C',
  raised: '#262624',
  hover: '#33332F',
  ink: '#EDEDEA',
  inkHover: '#FFFFFF',
  onInk: '#1A1A1A',
  muted: '#A3A39E',
  line: '#2F2F2C',
  lineStrong: '#3E3E3A',
  lineSubtle: '#353531',
  attention: '#E3B341',
  onAttention: '#1A1A1A',
  statusRunning: '#3FB950',
  statusWaiting: '#E3B341',
  statusError: '#F85149',
  guide: '#58A6FF',
  focus: '#EDEDEA',
  scrim: 'rgba(0, 0, 0, 0.45)',
  shadowFloat: '0 8px 24px rgba(0, 0, 0, 0.32)',
  mascot: '#D97757',
  mascotEye: '#1A1A1A',
  mascotProp: '#A3A39E',
  mascotFood: '#E3B341',
};

export const themes = { light, dark } as const;
export type ThemeName = keyof typeof themes;

/** 一种界面字体加一种等宽字体，都带系统字体兜底。fonts.css 会注册 Inter Variable 和 JetBrains Mono Variable。 */
export const font = {
  ui: '"Inter Variable", Inter, "PingFang SC", system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
} as const;

/** 字号只有这四档。 */
export const text = {
  xs: '11px',
  sm: '12px',
  md: '13px',
  lg: '15px',
} as const;

export const leading = '1.45';

export const weight = {
  regular: '400',
  medium: '500',
  strong: '600',
} as const;

/** 4px 网格。 */
export const space = {
  '2xs': '2px',
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '20px',
  '2xl': '24px',
} as const;

/** 控件高度：按钮、菜单行。 */
export const size = {
  controlSm: '22px',
  controlMd: '26px',
  row: '24px',
} as const;

/** 圆角三档：控件 6、窗口 8、框和面板 12。inset 只给嵌在 6 圆角容器里的高亮（菜单行），不算单独一档。 */
export const radius = {
  inset: '4px',
  control: '6px',
  window: '8px',
  frame: '12px',
} as const;

/** 动效一种：140ms 减速曲线。系统开了减少动效时时长变成 0。 */
export const motion = {
  duration: '140ms',
  ease: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

export const opacity = {
  disabled: '0.4',
} as const;

/** 层级：对话框里还能再弹菜单，所以 popover 在 dialog 上面。 */
export const z = {
  dialog: '1000',
  popover: '1100',
  toast: '1200',
} as const;

const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** 主题键对应的 CSS 变量名，例如 cssVarName('lineStrong') === '--line-strong'。 */
export const cssVarName = (key: keyof ThemeColors): string => `--${kebab(key)}`;

/** 在 TS 里引用 token（比如 inline style）时用这些，不要写颜色值。 */
export const vars = {
  color: Object.fromEntries(
    (Object.keys(light) as (keyof ThemeColors)[]).map((k) => [k, `var(${cssVarName(k)})`]),
  ) as { readonly [K in keyof ThemeColors]: string },
  font: { ui: 'var(--font-ui)', mono: 'var(--font-mono)' },
  text: { xs: 'var(--text-xs)', sm: 'var(--text-sm)', md: 'var(--text-md)', lg: 'var(--text-lg)' },
  radius: {
    inset: 'var(--radius-inset)',
    control: 'var(--radius-control)',
    window: 'var(--radius-window)',
    frame: 'var(--radius-frame)',
  },
  motion: 'var(--motion)',
} as const;

function themeBlock(selector: string, t: ThemeColors, scheme: ThemeName, indent = ''): string {
  const lines = (Object.keys(t) as (keyof ThemeColors)[]).map(
    (k) => `${indent}  ${cssVarName(k)}: ${t[k]};`,
  );
  return `${indent}${selector} {\n${indent}  color-scheme: ${scheme};\n${lines.join('\n')}\n${indent}}`;
}

/** 生成 tokens.css 的全文。 */
export function renderTokensCss(): string {
  const constants: [string, string][] = [
    ['--font-ui', font.ui],
    ['--font-mono', font.mono],
    ...Object.entries(text).map(([k, v]): [string, string] => [`--text-${k}`, v]),
    ['--leading', leading],
    ...Object.entries(weight).map(([k, v]): [string, string] => [`--weight-${k}`, v]),
    ...Object.entries(space).map(([k, v]): [string, string] => [`--space-${k}`, v]),
    ...Object.entries(size).map(([k, v]): [string, string] => [`--${kebab(k)}`, v]),
    ...Object.entries(radius).map(([k, v]): [string, string] => [`--radius-${k}`, v]),
    ['--motion-duration', motion.duration],
    ['--motion-ease', motion.ease],
    ['--motion', 'var(--motion-duration) var(--motion-ease)'],
    ...Object.entries(opacity).map(([k, v]): [string, string] => [`--opacity-${k}`, v]),
    ...Object.entries(z).map(([k, v]): [string, string] => [`--z-${k}`, v]),
  ];
  return [
    '/* 由 packages/design-tokens/scripts/gen-css.ts 从 src/index.ts 生成，不要手改。 */',
    '',
    ':root {',
    ...constants.map(([k, v]) => `  ${k}: ${v};`),
    '}',
    '',
    '/* 亮色是默认值。[data-theme] 可以放在任何元素上，只影响它里面。 */',
    themeBlock(':root,\n[data-theme="light"]', light, 'light'),
    '',
    themeBlock('[data-theme="dark"]', dark, 'dark'),
    '',
    '/* 没有指定主题时跟随系统。 */',
    '@media (prefers-color-scheme: dark) {',
    themeBlock(':root:not([data-theme="light"])', dark, 'dark', '  '),
    '}',
    '',
    '@media (prefers-reduced-motion: reduce) {',
    '  :root {',
    '    --motion-duration: 0ms;',
    '  }',
    '}',
    '',
  ].join('\n');
}
