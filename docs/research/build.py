"""把 entries.py 生成 docs/research-log.md 和 docs/design/agentdeck-research-log.html。

用法：python3 docs/research/build.py
"""
import html
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from entries import ENTRIES, STAGES  # noqa: E402

ROOT = HERE.parent.parent
MD_OUT = ROOT / 'docs' / 'research-log.md'
HTML_OUT = ROOT / 'docs' / 'design' / 'agentdeck-research-log.html'

STATUS = {
    'done': '已解决',
    'partial': '进行中',
    'deferred': '推迟',
    'pending': '待验证',
}
TODAY = date.today().isoformat()
E = html.escape


def counts():
    c = {k: 0 for k in STATUS}
    for e in ENTRIES:
        c[e['status']] += 1
    return c


def build_md():
    c = counts()
    out = [
        '# AgentDeck 调研记录',
        '',
        '实现过程中和一开始设想不一样的地方：原来以为什么、实际是什么、怎么决定的、好处和代价。',
        f'由 `docs/research/build.py` 从 `docs/research/entries.py` 生成，不要直接改这个文件。更新于 {TODAY}。',
        '',
        '共 ' + str(len(ENTRIES)) + ' 条：' + '，'.join(f'{STATUS[k]} {v}' for k, v in c.items()) + '。',
        '',
        '编号规则（全项目统一）：DR-xx 调研记录 · TC-xx 端到端用例 · IS-xx 问题 · F1、T2、X3 等是 MVP 任务表的任务编号。'
        '用例和问题在 docs/status/AgentDeck-端到端用例与问题清单-*.xlsx 里；每条调研下面列出相关的用例和问题。',
        '',
        '## 目录',
        '',
    ]
    for sid, name, desc in STAGES:
        out.append(f'- **{name}**：{desc}')
        for e in ENTRIES:
            if e['stage'] == sid:
                out.append(f'  - [{e["id"]} {e["title"]}](#{e["id"].lower()})（{STATUS[e["status"]]}）')
    out.append('')
    for sid, name, desc in STAGES:
        out += [f'## {name}', '', desc, '']
        for e in ENTRIES:
            if e['stage'] != sid:
                continue
            out += [f'<a id="{e["id"].lower()}"></a>', '', f'### {e["id"]} {e["title"]}', '', f'状态：{STATUS[e["status"]]} · 出处：{e["where"]} · 旧编号 {e["old"]}', '']
            if e['cases'] or e['issues']:
                out += ['相关：' + '、'.join(e['cases'] + e['issues']), '']
            out += [f'- **原来以为**：{e["assumed"]}', f'- **实际情况**：{e["found"]}']
            if e['status'] == 'pending':
                out += [f'- **怎么验证**：{e["decision"]}']
            else:
                out += [f'- **决策**：{e["decision"]}', f'- **好处**：{e["pros"]}', f'- **代价**：{e["cons"]}']
            out.append('')
    return '\n'.join(out)


def links(e):
    refs = e['cases'] + e['issues']
    if not refs:
        return ''
    return '相关 ' + ' '.join(f'<span class="ref">{E(r)}</span>' for r in refs) + ' · '


def build_html():
    c = counts()
    toc = []
    for sid, name, desc in STAGES:
        items = ''.join(
            f'<li><a href="#{e["id"].lower()}"><span class="mono">{e["id"]}</span>{E(e["title"])}</a>'
            f'<span class="st st-{e["status"]}">{STATUS[e["status"]]}</span></li>'
            for e in ENTRIES if e['stage'] == sid)
        toc.append(f'<section class="toc-group"><h3>{E(name)}</h3><ul>{items}</ul></section>')

    body = []
    for sid, name, desc in STAGES:
        arts = []
        for e in ENTRIES:
            if e['stage'] != sid:
                continue
            if e['status'] == 'pending':
                tail = f'<div class="row one"><div><span class="label">怎么验证</span><p>{E(e["decision"])}</p></div></div>'
            else:
                tail = (f'<div class="row one"><div><span class="label">决策</span><p>{E(e["decision"])}</p></div></div>'
                        f'<div class="row two"><div class="pro"><span class="label">好处</span><p>{E(e["pros"])}</p></div>'
                        f'<div class="con"><span class="label">代价</span><p>{E(e["cons"])}</p></div></div>')
            arts.append(f'''<article id="{e["id"].lower()}" class="entry">
  <header><span class="mono eid">{e["id"]}</span><h4>{E(e["title"])}</h4><span class="st st-{e["status"]}">{STATUS[e["status"]]}</span></header>
  <div class="row two"><div><span class="label">原来以为</span><p>{E(e["assumed"])}</p></div><div><span class="label">实际情况</span><p>{E(e["found"])}</p></div></div>
  {tail}
  <p class="where">{links(e)}出处：{E(e["where"])} · 旧编号 {E(e["old"])}</p>
</article>''')
        body.append(f'<section class="stage" id="stage-{sid.lower()}"><div class="stage-head"><h2>{E(name)}</h2><p>{E(desc)}</p></div>{"".join(arts)}</section>')

    facts = ''.join(f'<span><span class="st st-{k}">{STATUS[k]}</span> <b>{v}</b></span>' for k, v in c.items())

    return f'''<title>AgentDeck 调研记录</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Noto+Sans+SC:wght@400;500;700&display=swap">
<style>
/* Layout: a decision log — a compact table of contents by stage, then one entry per change, each reading assumption → reality → decision → benefit / cost. */
:root {{
  --ground: #F7F7F5; --surface: #FFFFFF; --ink: #1A1A1A; --muted: #6B6B66; --line: #E3E3DF; --soft: #F0F0EC;
  --attention: #C2410C; --good: #2F6B45;
  --font-ui: "IBM Plex Sans", "Noto Sans SC", "PingFang SC", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{
  --ground: #161615; --surface: #1E1E1C; --ink: #ECECE8; --muted: #9C9C95; --line: #34342F; --soft: #262623;
  --attention: #F08A4B; --good: #7DBB92; color-scheme: dark }} }}
:root[data-theme="dark"] {{
  --ground: #161615; --surface: #1E1E1C; --ink: #ECECE8; --muted: #9C9C95; --line: #34342F; --soft: #262623;
  --attention: #F08A4B; --good: #7DBB92; color-scheme: dark }}
* {{ box-sizing: border-box }}
body {{ background: var(--ground); color: var(--ink); font-family: var(--font-ui); font-size: 14px; line-height: 1.65;
  padding-block: 40px 80px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)) }}
.wrap {{ max-width: 1120px; margin: 0 auto; display: flex; flex-direction: column; gap: 44px }}
.mono {{ font-family: var(--font-mono); font-weight: 500 }}
.eyebrow {{ font-family: var(--font-mono); font-size: 12px; color: var(--muted); letter-spacing: .04em }}
header.page {{ display: flex; flex-direction: column; gap: 10px; max-width: 760px }}
h1 {{ margin: 0; font-size: 30px; font-weight: 600; text-wrap: balance }}
header.page p {{ margin: 0; color: var(--muted); font-size: 15px }}
.facts {{ display: flex; flex-wrap: wrap; gap: 8px 22px; font-size: 13px; color: var(--muted); margin-top: 4px }}
.facts b {{ color: var(--ink); font-variant-numeric: tabular-nums }}
.st {{ font-size: 11.5px; padding: 1px 7px; border-radius: 4px; white-space: nowrap; border: 1px solid transparent }}
.st-done {{ background: var(--ink); color: var(--ground) }}
.st-partial {{ border-color: var(--ink); color: var(--ink) }}
.st-deferred {{ border: 1px dashed var(--muted); color: var(--muted) }}
.st-pending {{ border-color: var(--attention); color: var(--attention) }}
.toc {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); overflow: hidden }}
.toc-group {{ padding: 14px 16px 16px; border-left: 1px solid var(--line); border-top: 1px solid var(--line); min-width: 0 }}
.toc-group:nth-child(3n+1) {{ border-left: 0 }}
.toc-group:nth-child(-n+3) {{ border-top: 0 }}
.toc-group h3 {{ margin: 0 0 8px; font-size: 14px; font-weight: 600; display: flex; gap: 8px }}
.toc-group ul {{ list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px }}
.toc-group li {{ display: flex; gap: 8px; align-items: baseline; justify-content: space-between; font-size: 13px }}
.toc-group a {{ color: var(--ink); text-decoration: none; display: flex; gap: 8px; min-width: 0 }}
.toc-group a .mono {{ color: var(--muted); font-size: 12px; flex: none; width: 44px }}
.toc-group a:hover {{ text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line) }}
a:focus-visible {{ outline: 2px solid var(--attention); outline-offset: 2px }}
.stage {{ display: flex; flex-direction: column; gap: 14px }}
.stage-head {{ display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; padding-bottom: 4px; border-bottom: 1px solid var(--line) }}
.stage-head h2 {{ margin: 0; font-size: 19px; font-weight: 600; display: flex; gap: 10px }}
.stage-head p {{ margin: 0; color: var(--muted); font-size: 13px }}
.entry {{ background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; scroll-margin-top: 16px }}
.entry:target {{ border-color: var(--ink) }}
.entry header {{ display: flex; align-items: baseline; gap: 10px }}
.entry h4 {{ margin: 0; font-size: 15px; font-weight: 600; flex: 1; min-width: 0; text-wrap: balance }}
.eid {{ color: var(--muted); font-size: 13px }}
.row {{ display: grid; gap: 12px 24px }}
.row.two {{ grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) }}
.row.one {{ grid-template-columns: minmax(0, 1fr) }}
.row p {{ margin: 2px 0 0; font-size: 13.5px; max-width: 68ch }}
.label {{ font-size: 11.5px; letter-spacing: .05em; color: var(--muted) }}
.row.one {{ padding-top: 10px; border-top: 1px solid var(--line) }}
.pro .label {{ color: var(--good) }}
.con .label {{ color: var(--attention) }}
.where {{ margin: 0; font-size: 12px; color: var(--muted) }}
.ref {{ font-family: var(--font-mono); font-size: 11.5px; color: var(--ink); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; margin-right: 2px }}
.rules {{ margin: 0; font-size: 13px; color: var(--muted) }}
.rules b {{ font-family: var(--font-mono); color: var(--ink); font-weight: 500 }}
.foot {{ font-size: 12.5px; color: var(--muted) }}
@media (max-width: 860px) {{
  .toc {{ grid-template-columns: minmax(0, 1fr) }}
  .toc-group {{ border-left: 0 !important; border-top: 1px solid var(--line) !important }}
  .toc-group:first-child {{ border-top: 0 !important }}
  .row.two {{ grid-template-columns: minmax(0, 1fr) }}
}}
</style>

<div class="wrap">
<header class="page">
  <span class="eyebrow">AgentDeck · 调研记录 · 更新于 {TODAY}</span>
  <h1>AgentDeck 调研记录</h1>
  <p>从画原型到写代码，哪些地方和一开始想的不一样：原来以为什么、实际是什么、怎么决定的、换来的好处和付出的代价。最后一组是已经有对策、还要等真东西试过的。</p>
  <div class="facts"><span>共 <b>{len(ENTRIES)}</b> 条</span>{facts}</div>
  <p class="rules">编号全项目统一：<b>DR-xx</b> 调研记录 · <b>TC-xx</b> 端到端用例 · <b>IS-xx</b> 问题 · <b>F1、T2、X3</b> 等是 MVP 任务表的任务。用例和问题在《AgentDeck 端到端用例与问题清单》xlsx 里，每条调研下面列出相关的用例和问题。</p>
</header>

<nav aria-label="目录"><div class="toc">{"".join(toc)}</div></nav>

{"".join(body)}

<p class="foot">源文件在仓库的 docs/research/entries.py，运行 python3 docs/research/build.py 会同时更新 docs/research-log.md 和这个页面。</p>
</div>
'''


MD_OUT.write_text(build_md() + '\n', encoding='utf-8')
HTML_OUT.write_text(build_html(), encoding='utf-8')
print(f'{len(ENTRIES)} entries → {MD_OUT.relative_to(ROOT)}, {HTML_OUT.relative_to(ROOT)}')
