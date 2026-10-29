// IS-124：网页窗口里开本地 PDF（agentdeck-file:// 的 iframe）能不能用 Chromium 自带的 PDF 查看、#page=N 能不能跳页；pptx 怎样。
// PDF 是沙盒里现写的 6 页（support/h4-pdf.ts，每页 “Page N” 加 N 条黑条）。打开走真的右键 › New browser、地址栏真键盘。
// 看 PDF 查看器：主进程里找 chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/ 的 frame（Chromium 的 PDF 扩展），
// 在里面读 viewer-page-selector 的页码和总页数；截图人看（“Page 5” 大字）。
//
// 2026-10-29 实测（Electron 45）时的问题和修法（IS-124）：
// - 沙盒化的 iframe 里 Chromium 不起 PDF 查看器（“can’t be shown”，Show it here 改了 mode 也还是 iframe）→ 本地 PDF 的 iframe 不加 sandbox。
// - 地址栏把 file://…pdf#page=4 换成路径 “…/paper.pdf#page=4”，prepare / ping 把 # 当成文件名 → 主进程第一个 ? 或 # 起算后缀。
// - 已经开着的 PDF 只改 # 不跳页 → 界面带一个变化的查询串（?r=n#page=N）重新载入（RS14）。
// - pptx 载入时变成下载（will-download，Electron 默认弹保存框）、窗口一直 “Loading…” → 界面不载入这类文件，
//   写 “This file can’t be shown on the board.” 和 Open in default app。测试里主进程照样记下下载、不让它弹。
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
  test('IS-124 a local PDF opened from the address bar shows in Chromium’s PDF viewer', async ({ deck }) => {
    const { pdf } = papers(deck);
    await deck.launch();
    const id = await openAddress(deck, pdf);
    const win = deck.windowEl(id);
    await expect(win.locator('iframe')).toHaveAttribute('src', /^agentdeck-file:\/\/\/.*\/paper\.pdf$/);
    await expect(win.locator('iframe')).not.toHaveAttribute('sandbox', /.*/);
    await expect.poll(() => viewers(deck), { timeout: 15_000 }).toEqual([{ page: '1', pages: 6 }]);
    await expect(win.getByText('This page can’t be shown on the board.')).toHaveCount(0);
    await expect(win.getByText('This file can’t be shown on the board.')).toHaveCount(0);
    await deck.screenshot('pdf-page-1');
  });

  test('IS-124 file://…paper.pdf#page=4 opens the PDF at page 4', async ({ deck }) => {
    const { pdf } = papers(deck);
    await deck.launch();
    const id = await openAddress(deck, `file://${pdf}#page=4`);
    const win = deck.windowEl(id);
    await expect(win.locator('iframe')).toHaveAttribute('src', /\/paper\.pdf#page=4$/, { timeout: 10_000 });
    await expect.poll(() => viewers(deck), { timeout: 15_000 }).toEqual([{ page: '4', pages: 6 }]);
    await deck.screenshot('pdf-page-4');
  });

  test('IS-124 another #page=N in the address bar on the open PDF jumps there (reloaded with a new query)', async ({ deck }) => {
    const { pdf } = papers(deck);
    const page = await deck.launch();
    await blockDownloads(deck);
    const id = await openAddress(deck, pdf);
    const win = deck.windowEl(id);
    const frame = win.locator('iframe');
    await expect.poll(() => viewers(deck), { timeout: 15_000 }).toEqual([{ page: '1', pages: 6 }]);
    expect(await page.evaluate((u) => (window as unknown as BrowserApi).agentdeck.browser.ping(u), `${pdf}#page=4`)).toEqual({ ok: true, status: 200 });

    const goTo = async (address: string) => {
      await win.getByRole('textbox', { name: 'Address' }).click();
      await page.keyboard.press('Meta+A');
      await page.keyboard.type(address, { delay: 2 });
      await page.keyboard.press('Enter');
    };
    await goTo(`file://${pdf}#page=5`);
    await expect(frame).toHaveAttribute('src', /\/paper\.pdf\?r=\d+#page=5$/);
    await expect.poll(() => viewers(deck), { timeout: 15_000 }).toEqual([{ page: '5', pages: 6 }]);
    await deck.screenshot('pdf-page-5');
    await goTo(`${pdf}#page=2`);
    await expect.poll(() => viewers(deck), { timeout: 15_000 }).toEqual([{ page: '2', pages: 6 }]);
    // 地址栏和存下的地址是路径加 #page，没有 ?r=
    await expect.poll(async () => (await deck.board()).windows.find((w) => w.id === id)?.data['url']).toBe(`${pdf}#page=2`);
    expect(await downloads(deck)).toEqual([]);
  });

  test('IS-124 a .pptx is not loaded: the window says it can’t be shown and offers the default app, nothing downloads', async ({ deck }) => {
    const { pptx } = papers(deck);
    await deck.launch();
    await blockDownloads(deck);
    const id = await openAddress(deck, pptx);
    const win = deck.windowEl(id);
    await expect(win.getByText('This file can’t be shown on the board.')).toBeVisible();
    await expect(win.getByRole('button', { name: 'Open in default app' })).toBeVisible();
    await expect(win.locator('iframe')).toHaveCount(0);
    await expect(win.locator('.ad-window-titlebar')).not.toContainText('Loading…');
    // 给它 2 秒：没有载入，也就没有下载（不点 Open in default app，免得真的开 Keynote / PowerPoint）
    await deck.page.waitForTimeout(2000);
    expect(await downloads(deck)).toEqual([]);
    expect(await viewers(deck)).toEqual([]);
    await deck.screenshot('pptx');
  });
});
