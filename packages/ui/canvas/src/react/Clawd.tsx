// 左下角的小吉祥物 Clawd：每 10 秒左右在白板底部随机冒出来一次，随机做一件事（举杠铃、写代码、吃饭），几秒后缩回去。
// 像素画：一格一个 <rect>，每个动作两帧，CSS steps 交替显示，不用图片。只是装饰：不挡鼠标，读屏器忽略。

import { useEffect, useState } from 'react';

export type ClawdActivity = 'lifting' | 'coding' | 'eating';
export const CLAWD_ACTIVITIES: readonly ClawdActivity[] = ['lifting', 'coding', 'eating'];

/** 两次出现之间多久（毫秒）。 */
export const CLAWD_EVERY_MS = 10_000;
/** 每次露面多久。 */
export const CLAWD_STAY_MS = 6_000;

type Px = readonly [x: number, y: number, w: number, h: number];

/** 身体（不含手臂）。格子坐标，viewBox 见下面。 */
const BODY: Px[] = [
  [2, 2, 12, 7],
  [3, 9, 1, 2],
  [5, 9, 1, 2],
  [10, 9, 1, 2],
  [12, 9, 1, 2],
];
const EYES_OPEN: Px[] = [
  [4, 4, 1, 2],
  [11, 4, 1, 2],
];
/** 吃得开心，眯眼。 */
const EYES_HAPPY: Px[] = [
  [4, 5, 2, 1],
  [10, 5, 2, 1],
];
const ARMS_REST: Px[] = [
  [0, 5, 2, 2],
  [14, 5, 2, 2],
];

interface Frame {
  body: Px[];
  eyes: Px[];
  /** 杠铃、电脑外壳、碗 */
  prop: Px[];
  /** 电脑屏幕 */
  screen?: Px[];
  /** 碗里的饭、送到嘴边的那一口 */
  food?: Px[];
  /** 屏幕上的代码 */
  ink?: Px[];
}

const FRAMES: Record<ClawdActivity, [Frame, Frame]> = {
  // 杠铃举过头顶 / 放到胸前
  lifting: [
    {
      body: [...BODY, [1, -2, 1, 7], [14, -2, 1, 7]],
      eyes: EYES_OPEN,
      prop: [[-3, -3, 22, 1], [-3, -5, 2, 5], [17, -5, 2, 5]],
    },
    {
      body: [...BODY, [1, 1, 1, 4], [14, 1, 1, 4]],
      eyes: EYES_HAPPY,
      prop: [[-3, 0, 22, 1], [-3, -2, 2, 5], [17, -2, 2, 5]],
    },
  ],
  // 右边一台电脑：屏幕上几行代码，光标一闪一闪；手在键盘上一上一下地敲
  coding: [
    {
      body: [...BODY, [0, 5, 2, 2], [14, 6, 3, 1]],
      eyes: [[5, 4, 1, 2], [12, 4, 1, 2]],
      prop: [[17, 1, 6, 6], [16, 7, 8, 1]],
      screen: [[18, 2, 4, 4]],
      ink: [[18, 2, 3, 1], [19, 4, 2, 1], [21, 4, 1, 1]],
    },
    {
      body: [...BODY, [0, 5, 2, 2], [14, 7, 3, 1]],
      eyes: [[5, 4, 1, 2], [12, 4, 1, 2]],
      prop: [[17, 1, 6, 6], [16, 7, 8, 1]],
      screen: [[18, 2, 4, 4]],
      ink: [[18, 2, 3, 1], [19, 4, 2, 1]],
    },
  ],
  // 右边一碗饭：手把一口送到脸边、眯眼；再伸回碗里
  eating: [
    {
      body: [...BODY, ...ARMS_REST.slice(0, 1), [14, 3, 2, 3]],
      eyes: EYES_HAPPY,
      prop: [[16, 7, 7, 1], [17, 8, 5, 1], [18, 9, 3, 1]],
      food: [[17, 6, 5, 1], [14, 1, 2, 2]],
    },
    {
      body: [...BODY, ...ARMS_REST.slice(0, 1), [14, 5, 3, 1]],
      eyes: EYES_OPEN,
      prop: [[16, 7, 7, 1], [17, 8, 5, 1], [18, 9, 3, 1]],
      food: [[17, 6, 5, 1], [18, 5, 3, 1]],
    },
  ],
};

/** 格子 -3..24 × -5..11，每格 2px：54 × 32 px。 */
const VIEW = { x: -3, y: -5, w: 27, h: 16 };
const CELL_PX = 2;

function Rects({ px, className }: { px: Px[]; className: string }) {
  return (
    <g className={className}>
      {px.map(([x, y, w, h]) => (
        <rect key={`${x},${y},${w},${h}`} x={x} y={y} width={w} height={h} />
      ))}
    </g>
  );
}

/** 一只 Clawd 做一件事，不管出现和消失。测试和以后别处想放一只时用。 */
export function ClawdSprite({ activity }: { activity: ClawdActivity }) {
  return (
    <svg
      className="ad-clawd-sprite"
      width={VIEW.w * CELL_PX}
      height={VIEW.h * CELL_PX}
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      data-activity={activity}
    >
      {FRAMES[activity].map((f, i) => (
        <g key={i} className={`ad-clawd-frame ad-clawd-frame-${i + 1}`}>
          <Rects px={f.prop} className="ad-clawd-prop" />
          {f.screen && <Rects px={f.screen} className="ad-clawd-screen" />}
          {f.ink && <Rects px={f.ink} className="ad-clawd-ink" />}
          {f.food && <Rects px={f.food} className="ad-clawd-food" />}
          <Rects px={f.body} className="ad-clawd-body" />
          <Rects px={f.eyes} className="ad-clawd-eye" />
        </g>
      ))}
    </svg>
  );
}

interface Visit {
  activity: ClawdActivity;
  /** 0..1：在底部左段的哪个位置 */
  spot: number;
}

/** 白板左下角（缩放按钮右边）那一段里随机冒出来。random 可注入，测试用。 */
export function Clawd({ random = Math.random }: { random?: () => number }) {
  const [visit, setVisit] = useState<Visit | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
    const appear = () => {
      const activity = CLAWD_ACTIVITIES[Math.floor(random() * CLAWD_ACTIVITIES.length)] ?? 'coding';
      setVisit({ activity, spot: random() });
      // 先挂上去再升起来，过渡才有起点
      later(20, () => setShown(true));
      later(CLAWD_STAY_MS, () => setShown(false));
      // 下一次：10 秒上下浮动 3 秒，不那么机械
      later(CLAWD_EVERY_MS + (random() - 0.5) * 6_000, appear);
    };
    later(CLAWD_EVERY_MS, appear);
    return () => timers.forEach(clearTimeout);
  }, [random]);

  if (!visit) return null;
  return (
    <div
      className="ad-clawd"
      data-shown={shown ? 'true' : 'false'}
      style={{ left: `calc(var(--clawd-left) + ${visit.spot.toFixed(3)} * var(--clawd-range))` }}
    >
      <ClawdSprite activity={visit.activity} />
    </div>
  );
}
