// 网页窗口（需求「7 · 网页窗口」，任务 U1 U2 U3）。
// 白板给的 props 是 contracts 的 WindowComponentProps<BrowserWindowData>，服务只走 window.agentdeck.browser。
//
// - 本地地址的内容是 iframe，跟着白板的 transform 一起缩放；主进程负责去掉 localhost 的 X-Frame-Options 等（BrowserService.prepare）。
// - 外部网站（google、github……）用 <webview>（IS-44）：它们拒绝被嵌进 iframe，登录也要顶层页面。
//   用哪种由 prepare 返回的 mode 决定；data.mode 为 webview 时本地地址也用 webview（出错页上的 Show it here）。
//   webview 同样跟着白板缩放；地址、能不能后退前进从它自己的事件读，没有小桥。
// - 地址栏：单击或 ⌘L 编辑，↩ 打开，Esc 取消；后退 ⌘[、前进 ⌘]、刷新 ⌘R；“Open in browser” 用系统浏览器打开。
// - 打开或刷新前先 ping：服务没起来时显示出错页（“… isn’t responding.” + Retry），不让 iframe 显示 Chromium 的出错页。
// - data.url 被白板改了（终端里又点了同一个 origin 的链接，U2）就跳过去；iframe 里自己跳转时把新地址写回 data.url。
// - 没聚焦时内容区盖一层透明罩：第一次单击只聚焦，不传给网页；滚轮交给白板平移。

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { BrowserService, BrowserWindowData, WindowComponentProps } from '@agentdeck/contracts';
import { Button } from '@agentdeck/ui-kit';
import {
  addressFromHref,
  displayAddress,
  isFileAddress,
  isLocalAddress,
  isLocalPdfSrc,
  isUnshownFile,
  normalizeAddress,
  pdfJumpSrc,
} from './address.ts';
import {
  BOARD_FRAME_NAME_PREFIX,
  ERROR_PAGE_PREFIX,
  boardCommand,
  parseFrameMessage,
  type BoardCommand,
} from './bridge.ts';
import { EMPTY_STACK, canStep, pushEntry, step, type NavStack } from './history.ts';
import { BackIcon, ExternalIcon, ForwardIcon, ReloadIcon } from './icons.tsx';
import './browser.css';

export type BrowserWindowProps = WindowComponentProps<BrowserWindowData>;

/**
 * 白板复用已开着的窗口时可以在 data 里带一个新的 reloadToken，表示“聚焦并刷新”（U2，同一地址已经开着）。
 * contracts 0.1.2 的 BrowserWindowData 还没有这个字段，见 CONTRACT_NOTES.md。
 */
type DataWithToken = BrowserWindowData & { reloadToken?: string | number };

type ErrorReason = 'unreachable' | 'refused' | 'missing' | 'invalid' | 'unsupported';

type View =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'page' }
  | { kind: 'error'; reason: ErrorReason; url: string; message?: string };

/** 用到的 Electron <webview> 元素的方法（界面不能 import electron，只列用到的）。 */
interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>;
  reload(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
}

/** webview 事件带的字段（Electron 挂在 Event 上）。 */
interface WebviewEvent extends Event {
  url?: string;
  isMainFrame?: boolean;
  errorCode?: number;
  errorDescription?: string;
}

/** 网页窗口 webview 的分区，和主进程 apps/desktop/src/main/browser/webview.ts 的 WEB_PARTITION 一致。 */
const WEB_PARTITION = 'persist:agentdeck-web';
/** did-fail-load 的 ERR_ABORTED：跳转被新的跳转顶掉，不算出错。 */
const ERR_ABORTED = -3;

/** webview 还没 dom-ready 时调它的方法会抛错：当作做不到。 */
function tryCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const LOADING = { text: 'Loading…', tone: 'muted', dot: 'hollow' } as const;
const NOT_RESPONDING = { text: 'Not responding', tone: 'error', dot: 'filled' } as const;
/** iframe 这么久还没有 load 事件，就 ping 一次看看服务还在不在。 */
const LOAD_WATCHDOG_MS = 8000;

function browserApi(): BrowserService {
  return window.agentdeck.browser;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function BrowserWindow(props: BrowserWindowProps): ReactNode {
  const { window: node, focused, updateData, setStatus, requestFocus } = props;
  const data = node.data as DataWithToken;

  const [view, setView] = useState<View>(() => (data.url === '' ? { kind: 'empty' } : { kind: 'loading' }));
  const [src, setSrc] = useState<string | null>(null);
  /** 本地 PDF 换页时查询串里的计数（pdfJumpSrc）。 */
  const pdfLoadsRef = useRef(0);
  const [mode, setMode] = useState<'frame' | 'webview'>('frame');
  /** 换 key 会重建 iframe：没有小桥时只能这样强制刷新。 */
  const [frameKey, setFrameKey] = useState(0);
  const [address, setAddress] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [frameNav, setFrameNav] = useState<{ back: boolean; forward: boolean } | null>(null);
  const [stack, setStack] = useState<NavStack>(EMPTY_STACK);

  const frameRef = useRef<HTMLIFrameElement>(null);
  const webviewRef = useRef<WebviewElement | null>(null);
  const modeRef = useRef<'frame' | 'webview'>('frame');
  const dataModeRef = useRef(data.mode);
  dataModeRef.current = data.mode;
  const inputRef = useRef<HTMLInputElement>(null);
  const selectOnMouseUpRef = useRef(false);
  /** 网页窗口认为当前显示的地址（data.url 的形式）。 */
  const currentRef = useRef<string | null>(null);
  /** 自己写进 data.url、白板还没传回来的地址，按顺序。 */
  const pendingWritesRef = useRef<string[]>([]);
  /** 每次导航加一，异步结果回来时比一下，过期的丢掉。 */
  const seqRef = useRef(0);
  /** 当前文档有小桥（收到过它的消息）。iframe 换文档时清掉。 */
  const bridgedRef = useRef(false);
  const srcRef = useRef<string | null>(null);
  const dataUrlRef = useRef(data.url);
  dataUrlRef.current = data.url;

  // 回调里要用最新的 props，但不想让 effect 因为白板每次给新函数而重跑。
  const propsRef = useRef({ updateData, setStatus, requestFocus });
  useLayoutEffect(() => {
    propsRef.current = { updateData, setStatus, requestFocus };
  });

  const writeUrl = useCallback((url: string) => {
    currentRef.current = url;
    if (url === dataUrlRef.current) return;
    pendingWritesRef.current.push(url);
    propsRef.current.updateData({ url });
  }, []);

  const showError = useCallback((reason: ErrorReason, url: string, message?: string) => {
    setView(message === undefined ? { kind: 'error', reason, url } : { kind: 'error', reason, url, message });
    propsRef.current.setStatus(reason === 'unreachable' ? NOT_RESPONDING : null);
  }, []);

  /** 打开 url（data.url 的形式：http(s) 地址或绝对路径）。 */
  const navigate = useCallback(
    async (url: string, options: { record?: boolean; force?: boolean; webview?: boolean } = {}) => {
      const seq = ++seqRef.current;
      const api = browserApi();
      setDraft(null);
      setDraftError(null);
      setAddress(url);
      currentRef.current = url;
      setView({ kind: 'loading' });
      propsRef.current.setStatus(LOADING);

      let prepared: { src: string; mode: 'frame' | 'webview' };
      try {
        const wantWebview = options.webview === true || dataModeRef.current === 'webview';
        prepared = await api.prepare(url, wantWebview ? { mode: 'webview' } : undefined);
      } catch (err) {
        if (seq === seqRef.current) showError('invalid', url, errorText(err));
        return;
      }
      if (seq !== seqRef.current) return;
      // 服务暂时没起来也记下这个地址，Retry 和重启后都还是它。
      writeUrl(url);
      let reachable = true;
      try {
        reachable = (await api.ping(url)).ok;
      } catch {
        // ping 自己出错时照样去加载，让 iframe 显示结果
      }
      if (seq !== seqRef.current) return;
      if (!reachable) {
        showError(isFileAddress(url) ? 'missing' : 'unreachable', url);
        return;
      }
      // pptx、docx 这类 Chromium 只会当下载处理（还会弹保存框）：不载入，给“用默认应用打开”
      if (isUnshownFile(url)) {
        showError('unsupported', url);
        return;
      }

      if (options.record !== false) setStack((s) => pushEntry(s, url));
      bridgedRef.current = false;
      setFrameNav(null);
      if (prepared.mode === 'webview') {
        const webview = webviewRef.current;
        if (modeRef.current === 'webview' && webview !== null && srcRef.current !== null) {
          // webview 已经在：让它自己跳，保留它的历史
          srcRef.current = prepared.src;
          void webview.loadURL(prepared.src).catch(() => {});
        } else {
          modeRef.current = 'webview';
          setMode('webview');
          srcRef.current = prepared.src;
          setSrc(prepared.src);
        }
        return;
      }
      const frame = modeRef.current === 'frame' ? frameRef.current : null;
      if (modeRef.current === 'frame') prepared.src = pdfJumpSrc(srcRef.current, prepared.src, ++pdfLoadsRef.current);
      if (modeRef.current !== 'frame') {
        modeRef.current = 'frame';
        setMode('frame');
        srcRef.current = prepared.src;
        setSrc(prepared.src);
      } else if (srcRef.current !== prepared.src) {
        srcRef.current = prepared.src;
        setSrc(prepared.src);
      } else if (options.force === true || frame?.contentWindow == null) {
        setFrameKey((k) => k + 1);
      } else {
        // src 没变（例如 iframe 里跳走后又在地址栏敲回原地址）：直接让 iframe 跳，保留它的历史。
        frame.contentWindow.location.href = prepared.src;
      }
    },
    [showError, writeUrl],
  );

  const post = useCallback((command: BoardCommand) => {
    frameRef.current?.contentWindow?.postMessage(boardCommand(command), '*');
  }, []);

  const reload = useCallback(async () => {
    const url = currentRef.current ?? dataUrlRef.current;
    if (url === '') return;
    const webview = modeRef.current === 'webview' ? webviewRef.current : null;
    if (webview !== null && view.kind !== 'error' && view.kind !== 'empty') {
      webview.reload();
      return;
    }
    if (view.kind === 'error' || view.kind === 'empty' || !bridgedRef.current) {
      await navigate(url, { record: false, force: true });
      return;
    }
    // 有小桥：先确认服务还在，再让页面自己 reload（保留滚动位置、表单之外的状态由页面决定）。
    const seq = ++seqRef.current;
    let reachable = true;
    try {
      reachable = (await browserApi().ping(url)).ok;
    } catch {
      // 同上
    }
    if (seq !== seqRef.current) return;
    if (!reachable) {
      showError(isFileAddress(url) ? 'missing' : 'unreachable', url);
      return;
    }
    setView({ kind: 'loading' });
    propsRef.current.setStatus(LOADING);
    post('reload');
  }, [navigate, post, showError, view.kind]);

  const go = useCallback(
    (delta: -1 | 1) => {
      const webview = modeRef.current === 'webview' ? webviewRef.current : null;
      if (webview !== null && view.kind !== 'error') {
        if (delta === -1) tryCall(() => webview.goBack(), undefined);
        else tryCall(() => webview.goForward(), undefined);
        return;
      }
      if (bridgedRef.current && view.kind !== 'error') {
        post(delta === -1 ? 'back' : 'forward');
        return;
      }
      const next = step(stack, delta);
      if (next === null) return;
      setStack(next.stack);
      void navigate(next.url, { record: false });
    },
    [navigate, post, stack, view.kind],
  );

  const openExternal = useCallback(() => {
    const url = currentRef.current ?? dataUrlRef.current;
    if (url !== '') void browserApi().openExternal(url).catch(() => {});
  }, []);

  const editAddress = useCallback(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, []);

  // data.url 变了：白板（终端里点了链接、从保存的白板恢复）让我们去别的地址。自己写回去的不算。
  useEffect(() => {
    const url = data.url;
    const pending = pendingWritesRef.current;
    const mine = pending.indexOf(url);
    if (mine !== -1) {
      pending.splice(0, mine + 1);
      return;
    }
    if (url === '') {
      currentRef.current = null;
      setView({ kind: 'empty' });
      return;
    }
    if (url === currentRef.current && srcRef.current !== null) return;
    void navigate(url);
  }, [data.url, navigate]);

  // reloadToken 变了：同一个地址又被打开了一次，刷新（U2）。第一次挂载不算。
  const tokenRef = useRef(data.reloadToken);
  useEffect(() => {
    if (tokenRef.current === data.reloadToken) return;
    tokenRef.current = data.reloadToken;
    void reload();
  }, [data.reloadToken, reload]);

  // iframe 里的小桥发来的消息。
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      const msg = parseFrameMessage(event.data);
      if (msg === null) return;
      if (msg.type === 'key') {
        if (msg.key === 'back') go(-1);
        else if (msg.key === 'forward') go(1);
        else if (msg.key === 'reload') void reload();
        else editAddress();
        return;
      }
      if (msg.href.startsWith(ERROR_PAGE_PREFIX)) {
        // Chromium 的出错页：服务没响应，或者页面拒绝被嵌入（不在改写名单里的网站）。
        bridgedRef.current = false;
        const url = currentRef.current ?? dataUrlRef.current;
        const seq = ++seqRef.current;
        void browserApi()
          .ping(url)
          .then(
            (r) => r.ok,
            () => false,
          )
          .then((ok) => {
            if (seq !== seqRef.current) return;
            if (ok) showError('refused', url);
            else showError(isFileAddress(url) ? 'missing' : 'unreachable', url);
          });
        return;
      }
      const url = addressFromHref(msg.href);
      // 页面可以自己伪造这条消息：只认 http(s)；本地文件只在本来就开着本地文件时才认，
      // 免得网页把一个本地路径塞进 data.url，下次打开时被当成用户选的文件放行。
      const current = currentRef.current ?? '';
      if (isFileAddress(url) ? !isFileAddress(current) : !/^https?:/i.test(url)) return;
      bridgedRef.current = true;
      setFrameNav({ back: msg.canGoBack, forward: msg.canGoForward });
      setAddress(url);
      writeUrl(url);
      setView((v) => (v.kind === 'loading' ? { kind: 'page' } : v));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [editAddress, go, reload, showError, writeUrl]);

  // webview 的事件：地址、能不能后退前进、加载状态、出错。
  const hasWebview = mode === 'webview' && src !== null;
  useEffect(() => {
    const webview = webviewRef.current;
    if (!hasWebview || webview === null) return;
    const syncNav = () =>
      setFrameNav({ back: tryCall(() => webview.canGoBack(), false), forward: tryCall(() => webview.canGoForward(), false) });
    const onNavigate = (event: Event) => {
      const e = event as WebviewEvent;
      if (e.isMainFrame === false || e.url === undefined || !/^https?:/i.test(e.url)) return;
      setAddress(e.url);
      writeUrl(e.url);
      syncNav();
    };
    const onStart = () => {
      setView((v) => (v.kind === 'page' ? { kind: 'loading' } : v));
      propsRef.current.setStatus(LOADING);
    };
    const onStop = () => {
      setView((v) => (v.kind === 'loading' ? { kind: 'page' } : v));
      propsRef.current.setStatus(null);
      syncNav();
    };
    const onFail = (event: Event) => {
      const e = event as WebviewEvent;
      if (e.isMainFrame === false || e.errorCode === ERR_ABORTED) return;
      const url = currentRef.current ?? dataUrlRef.current;
      showError('unreachable', url, e.errorDescription);
    };
    const events: [string, (e: Event) => void][] = [
      ['did-navigate', onNavigate],
      ['did-navigate-in-page', onNavigate],
      ['did-start-loading', onStart],
      ['did-stop-loading', onStop],
      ['did-fail-load', onFail],
    ];
    for (const [name, fn] of events) webview.addEventListener(name, fn);
    return () => {
      for (const [name, fn] of events) webview.removeEventListener(name, fn);
    };
  }, [hasWebview, showError, writeUrl]);

  // 加载太久（或者 load 事件被错过，例如窗口在后台）时 ping 一次：不通就显示出错页，通就当作已加载。
  useEffect(() => {
    if (view.kind !== 'loading' || src === null) return;
    const seq = seqRef.current;
    const timer = setTimeout(() => {
      const url = currentRef.current;
      if (url === null || seq !== seqRef.current) return;
      void browserApi()
        .ping(url)
        .then((r) => {
          if (seq !== seqRef.current) return;
          if (!r.ok) {
            showError(isFileAddress(url) ? 'missing' : 'unreachable', url);
            return;
          }
          setView((v) => (v.kind === 'loading' ? { kind: 'page' } : v));
          propsRef.current.setStatus(null);
        })
        .catch(() => {});
    }, LOAD_WATCHDOG_MS);
    return () => clearTimeout(timer);
  }, [view.kind, src, showError]);

  // 开始编辑时 value 从显示用的短地址换成完整地址，React 写 value 会把选区挪到末尾；渲染完马上全选回来。
  const editing = draft !== null;
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (editing && input !== null && document.activeElement === input) input.select();
  }, [editing]);

  // 没有地址的新窗口：聚焦时直接进入地址栏编辑。
  const isEmpty = data.url === '';
  useEffect(() => {
    if (focused && isEmpty) editAddress();
  }, [focused, isEmpty, editAddress]);

  const onFrameLoad = () => {
    // 有小桥时它会紧跟着报地址；先把加载状态清掉。
    setView((v) => (v.kind === 'loading' ? { kind: 'page' } : v));
    propsRef.current.setStatus(null);
    if (!bridgedRef.current) post('hello');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.metaKey || event.altKey || event.ctrlKey) return;
    const key = event.key.toLowerCase();
    if (key === '[') go(-1);
    else if (key === ']') go(1);
    else if (key === 'r') void reload();
    else if (key === 'l') editAddress();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const submitDraft = () => {
    const result = normalizeAddress(draft ?? address);
    if (!result.ok) {
      setDraftError(result.message);
      return;
    }
    inputRef.current?.blur();
    void navigate(result.url, { force: result.url === currentRef.current });
  };

  const cancelDraft = () => {
    setDraft(null);
    setDraftError(null);
  };

  const canBack = frameNav !== null && view.kind !== 'error' ? frameNav.back : canStep(stack, -1);
  const canForward = frameNav !== null && view.kind !== 'error' ? frameNav.forward : canStep(stack, 1);
  const shownUrl = currentRef.current ?? address;

  return (
    <div className="ad-browser" onKeyDown={onKeyDown}>
      <div className="ad-browser__toolbar">
        <Button variant="ghost" size="sm" aria-label="Back" title="Back (⌘[)" disabled={!canBack} onClick={() => go(-1)}>
          <BackIcon />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Forward"
          title="Forward (⌘])"
          disabled={!canForward}
          onClick={() => go(1)}
        >
          <ForwardIcon />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Reload"
          title="Reload (⌘R)"
          disabled={shownUrl === ''}
          onClick={() => void reload()}
        >
          <ReloadIcon />
        </Button>
        <input
          ref={inputRef}
          className="ad-browser__address"
          aria-label="Address"
          aria-invalid={draftError !== null}
          aria-describedby={draftError !== null ? `${node.id}-address-error` : undefined}
          spellCheck={false}
          autoComplete="off"
          placeholder="Enter an address or file path"
          value={draft ?? displayAddress(address)}
          onMouseDown={(e) => {
            // 第一次点进地址栏时全选；不然 mouseup 会把光标放到点的位置，选区就没了。
            selectOnMouseUpRef.current = document.activeElement !== e.currentTarget;
          }}
          onMouseUp={(e) => {
            if (!selectOnMouseUpRef.current) return;
            selectOnMouseUpRef.current = false;
            e.preventDefault();
            e.currentTarget.select();
          }}
          onFocus={() => setDraft(address)}
          onBlur={cancelDraft}
          onChange={(e) => {
            setDraft(e.target.value);
            setDraftError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitDraft();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.blur();
            }
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          aria-label="Open in browser"
          title="Open in browser"
          disabled={shownUrl === ''}
          onClick={openExternal}
        >
          <ExternalIcon />
        </Button>
      </div>
      {draftError !== null && (
        <div className="ad-browser__hint" id={`${node.id}-address-error`} role="alert">
          {draftError}
        </div>
      )}
      <div className="ad-browser__content">
        {src !== null && mode === 'webview' && (
          <webview
            ref={(el: HTMLElement | null) => {
              webviewRef.current = el as WebviewElement | null;
            }}
            className={view.kind === 'error' ? 'ad-browser__webview ad-browser__webview--hidden' : 'ad-browser__webview'}
            title={`Web page: ${displayAddress(shownUrl)}`}
            src={src}
            partition={WEB_PARTITION}
            // 第三方登录常用 window.open 弹窗；主进程只放行 http(s)。React 不认这个布尔属性，按字符串传。
            {...({ allowpopups: 'true' } as object)}
          />
        )}
        {src !== null && mode === 'frame' && (
          <iframe
            // sandbox 只在新载入时生效：本地 PDF 和别的页面之间切换时换一个 iframe
            key={isLocalPdfSrc(src) ? `${frameKey}-pdf` : frameKey}
            ref={frameRef}
            className="ad-browser__frame"
            name={`${BOARD_FRAME_NAME_PREFIX}${node.id}`}
            title={`Web page: ${displayAddress(shownUrl)}`}
            src={src}
            // 不给 allow-top-navigation：嵌进来的页面不能把白板页面跳走。
            // 本地 PDF 例外、不加 sandbox：沙盒化的 frame 里 Chromium 不起 PDF 查看器（IS-124）。PDF 由 Chromium 自己的查看器画，
            // agentdeck-file:// 的来源是不透明的 null，碰不到白板页面。
            sandbox={isLocalPdfSrc(src) ? undefined : 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads'}
            allow="clipboard-write; fullscreen"
            hidden={view.kind === 'error'}
            onLoad={onFrameLoad}
          />
        )}
        {view.kind === 'empty' && (
          <div className="ad-browser__message">
            <p>Enter an address above, for example localhost:3000 or a path to an HTML file.</p>
          </div>
        )}
        {view.kind === 'error' && (
          <ErrorPage
            view={view}
            onRetry={() => void navigate(view.url, { record: false, force: true })}
            onOpenExternal={openExternal}
            onShowHere={() => {
              // iframe 里登录跳到第三方网站（不在改写名单里）：这个窗口改用 webview，记进 data，重启后也是
              propsRef.current.updateData({ mode: 'webview' });
              void navigate(view.url, { record: false, force: true, webview: true });
            }}
          />
        )}
        {!focused && (
          <div
            className="ad-browser__shield"
            data-testid="browser-focus-shield"
            onPointerDown={(e) => {
              e.preventDefault();
              propsRef.current.requestFocus();
            }}
          />
        )}
      </div>
    </div>
  );
}

function ErrorPage(props: {
  view: Extract<View, { kind: 'error' }>;
  onRetry: () => void;
  onOpenExternal: () => void;
  onShowHere: () => void;
}): ReactNode {
  const { view, onRetry, onOpenExternal, onShowHere } = props;
  let title: string;
  let detail: string | null = null;
  let action: ReactNode;
  switch (view.reason) {
    case 'unreachable':
      title = `${displayAddress(view.url)} isn’t responding.`;
      detail = isLocalAddress(view.url)
        ? 'The dev server may not have started yet, or it stopped.'
        : 'Check the address and your network connection.';
      action = <Button size="sm" onClick={onRetry}>Retry</Button>;
      break;
    case 'missing':
      title = 'File not found';
      detail = view.url;
      action = <Button size="sm" onClick={onRetry}>Retry</Button>;
      break;
    case 'unsupported':
      title = 'This file can’t be shown on the board.';
      detail = view.url;
      action = (
        <Button size="sm" onClick={onOpenExternal}>
          Open in default app
        </Button>
      );
      break;
    case 'refused':
      if (isFileAddress(view.url)) {
        // 本地文件只走 iframe，Show it here 帮不上
        title = 'This file can’t be shown on the board.';
        detail = view.url;
        action = (
          <Button size="sm" onClick={onOpenExternal}>
            Open in default app
          </Button>
        );
        break;
      }
      title = 'This page can’t be shown on the board.';
      detail = 'It refuses to be embedded. Show it here as a separate web view, or open it in your browser.';
      action = (
        <div className="ad-browser__message-actions">
          <Button size="sm" onClick={onShowHere}>
            Show it here
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenExternal}>
            Open in browser
          </Button>
        </div>
      );
      break;
    case 'invalid':
      title = view.message ?? 'This address can’t be opened.';
      action = null;
      break;
  }
  return (
    <div className="ad-browser__message" role="status">
      <p className="ad-browser__message-title">{title}</p>
      {detail !== null && <p className="ad-browser__message-detail">{detail}</p>}
      {action}
    </div>
  );
}
