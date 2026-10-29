// IS-124：网页窗口里开本地 PDF（agentdeck-file:// 的 iframe）能不能用 Chromium 自带的 PDF 查看、#page=N 能不能跳页；pptx 怎样。
// PDF 是沙盒里现写的 6 页（support/h4-pdf.ts，每页 “Page N” 加 N 条黑条）。打开走真的右键 › New browser、地址栏真键盘。
// 看 PDF 查看器：主进程里找 chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/ 的 frame（Chromium 的 PDF 扩展），
// 在里面读 viewer-page-selector 的页码和总页数；截图人看（“Page 5” 大字）。
//
// 2026-10-29 实测（Electron 45）：
// - 现在打不开：iframe 带 sandbox，Chromium 不在沙盒化的 frame 里起 PDF 查看器，网页窗口显示 “This page can’t be shown on the board.”；
//   Show it here 改 data.mode = webview，但本地文件只走 iframe（service.ts prepare），又是同一个出错页。
// - #page=N 传不进去：地址栏把 file://…pdf#page=4 换成路径 “…/paper.pdf#page=4”，prepare / ping 把 # 当成文件名的一部分 → File not found。
//   （MCP open_browser 给 file:// 时 fileURLToPath 去掉了 #，给路径时同样 File not found。）
// - 去掉 sandbox 的 iframe（测试里改 DOM，等于修好后的样子）：PDF 查看器正常显示；只改 # 不跳页；带变化的 query（?r=2#page=5）再载入就跳到第 5 页（RS14 的结论）。
// - pptx：不能显示，载入时触发下载（will-download，pptx 的 MIME），窗口一直 “Loading…”。应用没有 will-download 处理，
//   Electron 默认会弹保存对话框；测试里在主进程拦下（preventDefault），没让它弹。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { writePdf } from '../support/h4-pdf.ts';

const PDF_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';

interface Viewer {
  page: string | null;
  pages: number | null;
}

type BrowserApi = {
  agentdeck: { browser: { ping(u: string): Promise<{ ok: boolean; status: number | null }>; prepare(u: string): Promise<{ src: string; mode: string }> } };
};

/** 沙盒里的 paper.pdf（6 页）和 slides.pptx。 */
function papers(deck: Deck): { pdf: string; pptx: string } {
  const dir = join(deck.sb.root, 'papers');
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, 'paper.pdf');
  writePdf(pdf, 6);
  // 只要扩展名和 MIME：Chromium 看到 pptx 就当下载，不看内容
  const pptx = join(dir, 'slides.pptx');
  writeFileSync(pptx, 'PK\u0003\u0004 not a real presentation');
  return { pdf, pptx };
}

/** 主进程：记下下载，不弹保存对话框。 */
async function blockDownloads(deck: Deck): Promise<void> {
  await deck.app.evaluate(({ session }) => {
    const g = globalThis as unknown as { __downloads?: { url: string; mime: string }[] };
    g.__downloads = [];
    session.defaultSession.on('will-download', (e, item) => {
      g.__downloads!.push({ url: item.getURL(), mime: item.getMimeType() });
      e.preventDefault();
    });
  });
}
const downloads = (deck: Deck) => deck.app.evaluate(() => (globalThis as unknown as { __downloads?: { url: string; mime: string }[] }).__downloads ?? []);

/** 右键 › New browser，地址栏打 address 回车，返回窗口 id。 */
async function openAddress(deck: Deck, address: string): Promise<string> {
  const page = deck.page;
  const p = await deck.emptyPoint('left');
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await deck.pickMenu(['New browser']);
  const id = await deck.waitForWindow((w) => w.type === 'browser');
  await deck.showAll();
  await deck.windowEl(id).getByRole('textbox', { name: 'Address' }).click();
  await page.keyboard.type(address, { delay: 2 });
  await page.keyboard.press('Enter');
  return id;
}

/** 白板页面里 Chromium 的 PDF 查看器（没有就是空数组）：当前页、总页数。 */
async function viewers(deck: Deck): Promise<Viewer[]> {
  return deck.app.evaluate(async ({ webContents }, prefix) => {
    const out: { page: string | null; pages: number | null }[] = [];
    for (const w of webContents.getAllWebContents()) {
      for (const f of w.mainFrame.framesInSubtree) {
        if (!f.url.startsWith(prefix)) continue;
        const r = (await f
          .executeJavaScript(
            `(() => { const sr = document.querySelector('pdf-viewer')?.shadowRoot; const ps = sr?.querySelector('viewer-toolbar')?.shadowRoot?.querySelector('viewer-page-selector');
               const input = ps?.shadowRoot?.querySelector('input'); return { page: input ? input.value : null, pages: ps ? (ps.docLength ?? null) : null }; })()`,
          )
          .catch(() => ({ page: null, pages: null }))) as { page: string | null; pages: number | null };
        out.push(r);
      }
    }
    return out;
  }, PDF_VIEWER);
}

test.describe('IS-124 local PDF in a browser window', () => {
  // 已知缺口（IS-124）：沙盒化的 iframe 起不了 PDF 查看器。修好后这条会“意外通过”，那时去掉 test.fail。
  test.fail('IS-124 a local PDF opened from the address bar shows in Chromium’s PDF viewer', async ({ deck }) => {
    const { pdf } = papers(deck);
    await deck.launch();
    const id = await openAddress(deck, pdf);
    const win = deck.windowEl(id);
    await expect(win.locator('iframe')).toHaveAttribute('src', /^agentdeck-file:\/\/\/.*\/paper\.pdf$/);
    await expect.poll(() => viewers(deck), { timeout: 15_000 }).toEqual([{ page: '1', pages: 6 }]);
    await expect(win.getByText('This page can’t be shown on the board.')).toHaveCount(0);
    await deck.screenshot('pdf-page-1');
  });

  // 已知缺口（IS-124）：地址栏 / open_browser 都传不进 #page=N（# 被当成文件名的一部分，或被去掉）。
  test.fail('IS-124 file://…paper.pdf#page=4 opens the PDF at page 4', async ({ deck }) => {
    const { pdf } = papers(deck);
    await deck.launch();
    const id = await openAddress(deck, `file://${pdf}#page=4`);
    const win = deck.windowEl(id);
    await expect(win.locator('iframe')).toHaveAttribute('src', /\/paper\.pdf#page=4$/, { timeout: 10_000 });
    await expect.poll(() => viewers(deck), { timeout: 15_000 }).toEqual([{ page: '4', pages: 6 }]);
    await deck.screenshot('pdf-page-4');
  });

  test('IS-124 today: the sandboxed frame refuses the PDF and Show it here loops; without the sandbox it shows and ?r=…#page=N jumps', async ({ deck }) => {
    const { pdf } = papers(deck);
    const page = await deck.launch();
    await blockDownloads(deck);
    const id = await openAddress(deck, pdf);
    const win = deck.windowEl(id);
    const frame = win.locator('iframe');
    // 1. 现在：sandbox 里的 iframe → Chromium 出错页 → 网页窗口的 “can’t be shown”
    await expect(frame).toHaveAttribute('src', /^agentdeck-file:\/\/\/.*\/paper\.pdf$/);
    await expect(frame).toHaveAttribute('sandbox', /allow-scripts/);
    await expect(win.getByText('This page can’t be shown on the board.')).toBeVisible();
    expect(await viewers(deck)).toEqual([]);
    await deck.screenshot('refused');

    // 2. Show it here：data.mode 变 webview，但本地文件仍然是 iframe，又是同一个出错页（没有 webview）
    await win.getByRole('button', { name: 'Show it here' }).click();
    await expect.poll(async () => (await deck.board()).windows.find((w) => w.id === id)?.data['mode']).toBe('webview');
    await expect(win.getByText('This page can’t be shown on the board.')).toBeVisible();
    await expect(win.locator('webview')).toHaveCount(0);
    expect(await viewers(deck)).toEqual([]);

    // 3. 地址里的 #page=N 被当成文件名：File not found（主进程的 ping 也说 404）
    await win.getByRole('textbox', { name: 'Address' }).click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.type(`file://${pdf}#page=4`, { delay: 2 });
    await page.keyboard.press('Enter');
    await expect(win.getByText('File not found')).toBeVisible();
    expect(await page.evaluate((u) => (window as unknown as BrowserApi).agentdeck.browser.ping(u), `${pdf}#page=4`)).toEqual({ ok: false, status: 404 });
    await deck.screenshot('hash-not-found');

    // 4. 修好后的样子（改 DOM：去掉 sandbox、藏出错页；src 用主进程 prepare 给的地址加后缀）
    const prepared = await page.evaluate((p) => (window as unknown as BrowserApi).agentdeck.browser.prepare(p), pdf);
    expect(prepared.mode).toBe('frame');
    const load = (url: string) =>
      page.evaluate(
        ({ id, url }) => {
          const content = document.querySelector(`.ad-window-node[data-window-id="${id}"] .ad-browser__content`)!;
          let f = content.querySelector('iframe');
          if (!f) {
            f = document.createElement('iframe');
            f.className = 'ad-browser__frame';
            content.prepend(f);
          }
          f.removeAttribute('sandbox');
          f.hidden = false;
          content.querySelectorAll<HTMLElement>(':scope > :not(iframe)').forEach((e) => (e.style.display = 'none'));
          f.src = url;
        },
        { id, url },
      );
    await load(prepared.src);
    await expect.poll(() => viewers(deck), { timeout: 15_000 }).toEqual([{ page: '1', pages: 6 }]);
    await deck.screenshot('no-sandbox-page-1');
    // 只改 #：不跳页（给它 3 秒机会；跳了就说明 RS14 的结论变了）
    await load(`${prepared.src}#page=4`);
    await page.waitForTimeout(3000);
    expect(await viewers(deck)).toEqual([{ page: '1', pages: 6 }]);
    // 带变化的 query 再载入：跳到第 5 页
    await load(`${prepared.src}?r=2#page=5`);
    await expect.poll(() => viewers(deck), { timeout: 15_000 }).toEqual([{ page: '5', pages: 6 }]);
    await deck.screenshot('no-sandbox-page-5');
    expect(await downloads(deck)).toEqual([]);
  });

  test('IS-124 today: a .pptx is not displayed; Chromium turns it into a download', async ({ deck }) => {
    const { pptx } = papers(deck);
    await deck.launch();
    await blockDownloads(deck);
    const id = await openAddress(deck, pptx);
    const win = deck.windowEl(id);
    await expect(win.locator('iframe')).toHaveAttribute('src', /^agentdeck-file:\/\/\/.*\/slides\.pptx$/);
    await expect.poll(async () => (await downloads(deck)).map((d) => d.mime)).toEqual(['application/vnd.openxmlformats-officedocument.presentationml.presentation']);
    expect((await downloads(deck))[0]!.url).toMatch(/^agentdeck-file:\/\/\/.*\/slides\.pptx$/);
    // 什么也没显示：没有 PDF 查看器，标题栏一直 Loading…
    expect(await viewers(deck)).toEqual([]);
    await expect(win.locator('.ad-window-titlebar')).toContainText('Loading…');
    await deck.screenshot('pptx');
  });
});
