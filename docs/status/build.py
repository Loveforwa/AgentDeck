"""生成验收报告：docs/status/index.html（截图在 shots/）。

数据来源：
- data.py：功能清单、烟测、39 项 P0 的证据、14 条验收场景的现状、验货步骤、下一步
- tracking.py：端到端用例（TC-xx）和问题清单（IS-xx）
- ../research/entries.py：调研记录（DR-xx），这里只放索引

网页上填的验收结果和处理状态存在网页自己的数据库（db 能力）里：
集合 acceptance/<TC-xx> = {result, note, at}，issues/<IS-xx> = {status, note, at}。

用法：python3 docs/status/build.py
"""
import html
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / 'research'))
import data as D  # noqa: E402
from tracking import CASES, ISSUES, RESOLVED  # noqa: E402
from entries import ENTRIES as RESEARCH, STAGES  # noqa: E402

ROOT = HERE.parent.parent
HTML_OUT = HERE / 'index.html'
RESEARCH_URL = 'https://claude.ai/artifact/M9eSh1RhsiZhP9FCPbmnwK'
E = html.escape

P0_LABEL = {'auto': '完成，有自动测试', 'manual': '完成，只有手动验证', 'partial': '部分完成 / 未做'}
SMOKE_LABEL = {'ok': '通过', 'skip': '没跑', 'none': '没有'}
CASE_ORDER = ['⚠ 当前有问题', '未验证', '部分验证', '已验证', '未实现']
CASE_CLASS = {'⚠ 当前有问题': 'prob', '未验证': 'no', '部分验证': 'part', '已验证': 'ok', '未实现': 'todo'}
P_ORDER = ['P0', 'P1', 'P2', 'P3']
P_LABEL = {'P0': '阻塞 MVP 验收', 'P1': '主要流程，交付前要处理', 'P2': '次要体验、完整性、性能', 'P3': '清理'}
RESULTS = ['通过', '不通过', '阻塞', '跳过']
ISSUE_STATES = ['待处理', '处理中', '已解决', '不处理']
RS_STATUS = {'done': '已解决', 'partial': '进行中', 'deferred': '推迟', 'pending': '待验证'}


def count(rows, key_index, keys):
    return {k: sum(1 for r in rows if r[key_index] == k) for k in keys}


P0C = count(D.P0, 2, P0_LABEL)
cases = sorted(CASES, key=lambda k: (CASE_ORDER.index(k['status']), P_ORDER.index(k['p']), k['id']))
issues = sorted(ISSUES, key=lambda x: (P_ORDER.index(x[1]), x[0]))
CASEC = {s: sum(1 for k in CASES if k['status'] == s) for s in CASE_ORDER}
ISSUEC = {p: sum(1 for i in ISSUES if i[1] == p) for p in P_ORDER}


def research_for(ref):
    return [e['id'] for e in RESEARCH if ref in e['cases'] or ref in e['issues']]


def refs_of(text):
    return [r for r in (text or '').replace('、', ' ').split() if r[:3] in ('TC-', 'IS-')]


# ---------------- Markdown ----------------

# ---------------- 网页 ----------------

def chip(cls, text):
    return f'<span class="st st-{cls}">{E(text)}</span>'


def ref_links(refs):
    out = []
    for r in refs:
        if r.startswith('DR-'):
            out.append(f'<a class="ref" href="{RESEARCH_URL}#{r.lower()}" target="_blank" rel="noopener">{E(r)}</a>')
        else:
            out.append(f'<a class="ref" href="#{r.lower()}">{E(r)}</a>')
    return ' '.join(out)


def select(id_, attr, options, value, empty=None):
    opts = ''
    if empty is not None:
        opts += f'<option value=""{" selected" if not value else ""}>{E(empty)}</option>'
    opts += ''.join(f'<option{" selected" if o == value else ""}>{E(o)}</option>' for o in options)
    return f'<select id="{id_}" {attr}>{opts}</select>'


def case_html(k):
    cid = k['id']
    cls = CASE_CLASS[k['status']]
    rel = refs_of(k['rel'])
    dr = research_for(cid)
    links = ''
    if rel or dr:
        links = '<p class="links">' + (f'关联问题 {ref_links(rel)}' if rel else '') + (' · ' if rel and dr else '') + (f'相关调研 {ref_links(dr)}' if dr else '') + '</p>'
    steps = ''.join(f'<li>{E(s.split(". ", 1)[-1])}</li>' for s in k['steps'].split('\n'))
    expect = ''.join(f'<p>{E(line)}</p>' for line in k['expect'].split('\n'))
    return f'''<article class="case c-{cls}" id="{cid.lower()}" data-case="{cid}" data-status="{cls}" data-result="">
  <div class="case-head">
    <span class="mono cid">{cid}</span><span class="pri pri-{k["p"]}">{k["p"]}</span>{chip(cls, k["status"].replace("⚠ ", ""))}
    <h4>{E(k["scene"])}</h4>
    <label class="field result"><span>验收结果</span>{select("res-" + cid, f'data-tc="{cid}" class="res"', RESULTS, "", "未验收")}</label>
  </div>
  <p class="now"><span class="label">当前情况</span>{E(k["issue"])}</p>
  <details>
    <summary>前置要求、操作步骤和预期</summary>
    <div class="spec">
      <div><span class="label">前置要求</span><p>{E(k["pre"])}</p></div>
      <div><span class="label">操作步骤</span><ol>{steps}</ol></div>
      <div class="wide-cell"><span class="label">UI / 后台预期表现</span>{expect}</div>
      <div class="wide-cell"><span class="label">最终效果</span><p>{E(k["result"])}</p></div>
    </div>
  </details>
  {links}
  <label class="field note"><span>验收备注</span><textarea id="note-{cid}" data-tc="{cid}" class="tc-note" rows="1" placeholder="哪里不对、怎么复现"></textarea></label>
</article>'''


def issue_html(i):
    iid, p, typ, mod, desc, how, impact, fix, rel = i
    state = '已解决' if iid in RESOLVED else '待处理'
    note = RESOLVED.get(iid, '')
    dr = research_for(iid)
    rels = refs_of(rel)
    links = ''
    if rels or dr:
        links = '<p class="links">' + (f'关联用例 {ref_links(rels)}' if rels else '') + (' · ' if rels and dr else '') + (f'相关调研 {ref_links(dr)}' if dr else '') + '</p>'
    return f'''<article class="issue" id="{iid.lower()}" data-issue="{iid}" data-state="{state}">
  <div class="case-head">
    <span class="mono cid">{iid}</span><span class="pri pri-{p}">{p}</span><span class="tag">{E(typ)}</span><span class="mod">{E(mod)}</span>
    <label class="field result"><span>处理状态</span>{select("st-" + iid, f'data-is="{iid}" class="ist"', ISSUE_STATES, state)}</label>
  </div>
  <p class="desc">{E(desc)}</p>
  <details>
    <summary>怎么复现、影响、建议处理</summary>
    <div class="spec">
      <div><span class="label">怎么复现 / 验证</span><p>{E(how)}</p></div>
      <div><span class="label">影响</span><p>{E(impact)}</p></div>
      <div class="wide-cell"><span class="label">建议处理</span><p>{E(fix)}</p></div>
    </div>
  </details>
  {links}
  <label class="field note"><span>处理备注</span><textarea id="isnote-{iid}" data-is="{iid}" class="is-note" rows="1" placeholder="处理到哪了">{E(note)}</textarea></label>
</article>'''


def page():
    feats = ''.join(
        f'<section class="feat"><h3>{E(g)}</h3><ul>' + ''.join(f'<li>{E(x)}</li>' for x in items) + '</ul></section>'
        for g, items in D.FEATURES)
    smoke = ''.join(
        f'<tr><td class="b">{E(a)}</td><td>{chip(b, SMOKE_LABEL[b])}</td><td>{E(c)}</td></tr>' for a, b, c in D.SMOKE)
    p0 = ''.join(
        f'<tr><td class="mono b">{i}</td><td class="b">{E(t)}</td><td>{chip(s, P0_LABEL[s])}</td>'
        f'<td>{E(a)}</td><td>{E(m)}</td><td class="muted">{E(n)}</td></tr>' for i, t, s, a, m, n in D.P0)
    case_list = ''.join(case_html(k) for k in cases)
    issue_groups = ''.join(
        f'<section class="pgroup"><h3><span class="pri pri-{p}">{p}</span>{E(P_LABEL[p])}<span class="muted"> · {ISSUEC[p]} 条</span></h3>'
        + ''.join(issue_html(i) for i in issues if i[1] == p) + '</section>'
        for p in P_ORDER)
    stage_name = {sid: name for sid, name, _ in STAGES}
    research_rows = ''.join(
        f'<tr><td><a class="ref" href="{RESEARCH_URL}#{e["id"].lower()}" target="_blank" rel="noopener">{e["id"]}</a></td>'
        f'<td class="muted">{E(stage_name[e["stage"]])}</td><td>{E(e["title"])}</td><td>{E(RS_STATUS[e["status"]])}</td>'
        f'<td>{ref_links(e["cases"] + e["issues"])}</td></tr>' for e in RESEARCH)
    tries = ''.join(
        f'<li><div class="try-h"><b>{E(a)}</b></div><code>{E(b)}</code><p>{E(c)}</p></li>' for a, b, c in D.TRY)
    nexts = ''.join(f'<li>{E(x)}</li>' for x in D.NEXT)
    bar = ''.join(
        f'<span class="seg seg-{k}" style="flex:{v}" title="{E(P0_LABEL[k])} {v}"></span>' for k, v in P0C.items() if v)
    case_bar = ''.join(
        f'<span class="seg seg-{CASE_CLASS[s]}" style="flex:{v}"></span>' for s, v in CASEC.items() if v)
    resolved0 = sum(1 for i in ISSUES if i[0] in RESOLVED)
    meta = json.dumps({'cases': [k['id'] for k in CASES], 'issues': [i[0] for i in ISSUES],
                       'defaults': {iid: {'status': '已解决', 'note': n} for iid, n in RESOLVED.items()}}, ensure_ascii=False)
    chips = ''.join(
        f'<button type="button" class="chip" data-filter="{f}" aria-pressed="{"true" if f == "all" else "false"}">{E(t)} <span class="n" data-count="{f}"></span></button>'
        for f, t in [('all', '全部'), ('prob', '当前有问题'), ('todo-acc', '还没验收'), ('fail', '不通过'), ('pass', '通过')])

    return f'''<title>AgentDeck MVP 验收报告</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Noto+Sans+SC:wght@400;500;700&display=swap">
<style>
/* Layout: an acceptance workbook as a page — summary and live progress on top, then evidence, the 24 end-to-end cases (fill results inline), the issue list by P level (fill status inline), the research index and the how-to. */
:root {{
  --ground: #F7F7F5; --surface: #FFFFFF; --ink: #1A1A1A; --muted: #6B6B66; --line: #E3E3DF; --soft: #F0F0EC;
  --attention: #C2410C; --attention-soft: #FBE9DF; --good: #2F6B45; --good-soft: #E3EFE7; --partial: #8A6D1F; --bad: #A3271B; --bad-soft: #F7E1DE;
  --font-ui: "IBM Plex Sans", "Noto Sans SC", "PingFang SC", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{
  --ground: #161615; --surface: #1E1E1C; --ink: #ECECE8; --muted: #9C9C95; --line: #34342F; --soft: #262623;
  --attention: #F08A4B; --attention-soft: #3A271C; --good: #7DBB92; --good-soft: #1F2D24; --partial: #D8B65A; --bad: #EF8A7E; --bad-soft: #3A2220; color-scheme: dark }} }}
:root[data-theme="dark"] {{
  --ground: #161615; --surface: #1E1E1C; --ink: #ECECE8; --muted: #9C9C95; --line: #34342F; --soft: #262623;
  --attention: #F08A4B; --attention-soft: #3A271C; --good: #7DBB92; --good-soft: #1F2D24; --partial: #D8B65A; --bad: #EF8A7E; --bad-soft: #3A2220; color-scheme: dark }}
* {{ box-sizing: border-box }}
body {{ background: var(--ground); color: var(--ink); font-family: var(--font-ui); font-size: 14px; line-height: 1.65;
  padding-block: 40px 80px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)) }}
.wrap {{ max-width: 1180px; margin: 0 auto; display: flex; flex-direction: column; gap: 44px }}
.mono {{ font-family: var(--font-mono); font-weight: 500 }}
.muted {{ color: var(--muted) }}
.b {{ font-weight: 600 }}
.eyebrow {{ font-family: var(--font-mono); font-size: 12px; color: var(--muted); letter-spacing: .04em }}
header {{ display: flex; flex-direction: column; gap: 12px }}
h1 {{ margin: 0; font-size: 30px; font-weight: 600; text-wrap: balance }}
h2 {{ margin: 0; font-size: 19px; font-weight: 600 }}
h3 {{ margin: 0; font-size: 15px; font-weight: 600 }}
h4 {{ margin: 0; font-size: 14.5px; font-weight: 600; flex: 1 1 260px; min-width: 0; text-wrap: balance }}
.lede {{ margin: 0; font-size: 15.5px; max-width: 72ch }}
.rules {{ margin: 0; font-size: 13px; color: var(--muted) }}
.rules b {{ font-family: var(--font-mono); color: var(--ink); font-weight: 500 }}
.bars {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px 28px; margin-top: 6px }}
.barbox {{ display: flex; flex-direction: column; gap: 8px; min-width: 0 }}
.barbox .t {{ font-size: 13px; color: var(--muted) }}
.bar {{ display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--soft); gap: 2px }}
.seg-auto, .seg-ok, .seg-pass {{ background: var(--good) }}
.seg-manual, .seg-part {{ background: var(--partial) }}
.seg-partial, .seg-no {{ background: var(--muted) }}
.seg-todo {{ background: var(--line) }}
.seg-prob, .seg-fail {{ background: var(--attention) }}
.legend {{ display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12.5px; color: var(--muted) }}
.legend b {{ color: var(--ink); font-variant-numeric: tabular-nums }}
.dot {{ display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: 0 }}
section.block {{ display: flex; flex-direction: column; gap: 14px }}
.head {{ display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px }}
.head p {{ margin: 0; color: var(--muted); font-size: 13px }}
.save-state {{ font-size: 12.5px; color: var(--muted) }}
.save-state.bad {{ color: var(--bad) }}
.shots {{ display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px }}
figure {{ margin: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0 }}
figure img {{ width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; display: block }}
figcaption {{ font-size: 12.5px; color: var(--muted) }}
.feats {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); overflow: hidden }}
.feat {{ padding: 14px 16px 16px; border-left: 1px solid var(--line); border-top: 1px solid var(--line); min-width: 0 }}
.feat:nth-child(3n+1) {{ border-left: 0 }}
.feat:nth-child(-n+3) {{ border-top: 0 }}
.feat ul {{ margin: 8px 0 0; padding-left: 1.1em; display: flex; flex-direction: column; gap: 5px; font-size: 13px }}
.tbl {{ overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--surface) }}
table {{ border-collapse: collapse; width: 100%; font-size: 13px }}
.wide {{ min-width: 980px }}
th {{ text-align: left; font-size: 12px; font-weight: 600; color: var(--muted); background: var(--soft); padding: 8px 12px; white-space: nowrap; border-bottom: 1px solid var(--line) }}
td {{ padding: 9px 12px; border-top: 1px solid var(--line); vertical-align: top }}
tr:first-child td {{ border-top: 0 }}
.st {{ font-size: 11.5px; padding: 1px 7px; border-radius: 4px; white-space: nowrap; border: 1px solid transparent; display: inline-block }}
.st-auto, .st-ok {{ background: var(--good); color: var(--surface) }}
.st-manual, .st-part, .st-skip {{ border-color: var(--partial); color: var(--partial) }}
.st-partial, .st-no, .st-none {{ border: 1px dashed var(--muted); color: var(--muted) }}
.st-todo {{ border: 1px dashed var(--line); color: var(--muted) }}
.st-prob {{ background: var(--attention); color: var(--surface) }}
.pri {{ font-family: var(--font-mono); font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--line); color: var(--muted) }}
.pri-P0 {{ background: var(--attention); border-color: var(--attention); color: var(--surface) }}
.pri-P1 {{ border-color: var(--attention); color: var(--attention) }}
.chips {{ display: flex; flex-wrap: wrap; gap: 8px }}
.chip {{ font: inherit; font-size: 12.5px; height: 30px; padding: 0 11px; border-radius: 6px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: pointer; display: inline-flex; align-items: center; gap: 6px }}
.chip .n {{ color: var(--muted); font-variant-numeric: tabular-nums }}
.chip[aria-pressed="true"] {{ background: var(--ink); color: var(--ground); border-color: var(--ink) }}
.chip[aria-pressed="true"] .n {{ color: inherit; opacity: .7 }}
.cases, .pgroup {{ display: flex; flex-direction: column; gap: 10px }}
.pgroup h3 {{ display: flex; align-items: center; gap: 8px; margin-top: 8px }}
.case, .issue {{ background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; scroll-margin-top: 16px }}
.case:target, .issue:target {{ border-color: var(--ink) }}
.case.c-prob {{ border-left: 3px solid var(--attention) }}
.case[data-result="不通过"] {{ background: var(--bad-soft) }}
.case[data-result="通过"] {{ background: var(--good-soft) }}
.issue[data-state="已解决"] {{ opacity: .72 }}
.case-head {{ display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px }}
.cid {{ font-size: 13px; min-width: 44px }}
.tag {{ font-size: 11.5px; border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; color: var(--muted) }}
.mod {{ font-size: 12.5px; color: var(--muted); flex: 1 1 200px; min-width: 0 }}
.field {{ display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted) }}
.field.result {{ margin-left: auto }}
.field.note {{ display: flex; align-items: flex-start }}
.field.note span {{ padding-top: 6px; white-space: nowrap }}
select, textarea {{ font: inherit; font-size: 13px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px }}
select {{ height: 30px }}
textarea {{ flex: 1; min-width: 0; resize: vertical; min-height: 32px }}
select:focus-visible, textarea:focus-visible, .chip:focus-visible, a:focus-visible, summary:focus-visible {{ outline: 2px solid var(--attention); outline-offset: 2px }}
select:disabled, textarea:disabled {{ opacity: .6 }}
.now, .desc {{ margin: 0; font-size: 13.5px }}
.c-prob .now {{ color: var(--attention) }}
.label {{ display: block; font-size: 11.5px; letter-spacing: .04em; color: var(--muted) }}
.now .label {{ display: inline; margin-right: 8px }}
details summary {{ cursor: pointer; font-size: 12.5px; color: var(--muted) }}
.spec {{ display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px 24px; margin-top: 10px; font-size: 13px }}
.spec p {{ margin: 2px 0 0 }}
.spec ol {{ margin: 2px 0 0; padding-left: 1.2em }}
.wide-cell {{ grid-column: 1 / -1 }}
.links {{ margin: 0; font-size: 12.5px; color: var(--muted) }}
.ref {{ font-family: var(--font-mono); font-size: 11.5px; color: var(--ink); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; text-decoration: none }}
.ref:hover {{ border-color: var(--ink) }}
.list {{ margin: 0; padding-left: 1.2em; display: flex; flex-direction: column; gap: 7px; font-size: 13.5px }}
.try {{ list-style: none; margin: 0; padding: 0; counter-reset: s; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 10px; background: var(--surface) }}
.try li {{ counter-increment: s; padding: 12px 16px 12px 48px; border-top: 1px solid var(--line); position: relative }}
.try li:first-child {{ border-top: 0 }}
.try li::before {{ content: counter(s); position: absolute; left: 16px; top: 12px; font-family: var(--font-mono); font-size: 12px; color: var(--muted) }}
.try code {{ display: inline-block; margin-top: 4px; font-family: var(--font-mono); font-size: 12.5px; background: var(--soft); padding: 2px 6px; border-radius: 4px; overflow-wrap: anywhere }}
.try p {{ margin: 4px 0 0; font-size: 13px; color: var(--muted) }}
.collapse > summary {{ font-size: 19px; font-weight: 600; color: var(--ink); list-style: none }}
.collapse > summary::after {{ content: "  展开"; font-size: 12.5px; font-weight: 400; color: var(--muted) }}
.collapse[open] > summary::after {{ content: "  收起" }}
@media (max-width: 900px) {{
  .bars, .shots, .spec {{ grid-template-columns: minmax(0, 1fr) }}
  .feats {{ grid-template-columns: minmax(0, 1fr) }}
  .feat {{ border-left: 0 !important; border-top: 1px solid var(--line) !important }}
  .feat:first-child {{ border-top: 0 !important }}
  .field.result {{ margin-left: 0 }}
}}
</style>

<div class="wrap">
<header>
  <span class="eyebrow">AgentDeck · MVP 验收报告 · {D.DATE} · main {D.COMMIT}</span>
  <h1>AgentDeck MVP 验收报告</h1>
  <p class="lede">第一个能打开、能用的版本已经组装好：白板、tmux 托管的真终端、工作区和 Git 面板、agent 状态提醒、网页窗口接在了一起。下面的端到端用例可以直接在这页上验收，问题清单可以直接改处理状态，填的内容会保存下来。</p>
  <p class="rules">编号：<b>TC-xx</b> 端到端用例（TC-01 到 TC-14 是 14 条验收场景）· <b>IS-xx</b> 问题 · <b>DR-xx</b> 调研记录 · <b>F1、T2</b> 等是任务编号。</p>
  <div class="bars">
    <div class="barbox"><span class="t">39 项基础功能（P0 任务）</span><div class="bar">{bar}</div>
      <div class="legend"><span><i class="dot seg-auto"></i>有自动测试 <b>{P0C["auto"]}</b></span><span><i class="dot seg-manual"></i>只有手动验证 <b>{P0C["manual"]}</b></span><span><i class="dot seg-partial"></i>部分完成 / 未做 <b>{P0C["partial"]}</b></span></div></div>
    <div class="barbox"><span class="t">{len(CASES)} 条端到端用例的现状</span><div class="bar">{case_bar}</div>
      <div class="legend"><span><i class="dot seg-prob"></i>当前有问题 <b>{CASEC["⚠ 当前有问题"]}</b></span><span><i class="dot seg-no"></i>未验证 <b>{CASEC["未验证"]}</b></span><span><i class="dot seg-part"></i>部分验证 <b>{CASEC["部分验证"]}</b></span><span><i class="dot seg-ok"></i>已验证 <b>{CASEC["已验证"]}</b></span><span><i class="dot seg-todo"></i>未实现 <b>{CASEC["未实现"]}</b></span></div></div>
    <div class="barbox"><span class="t">你的验收进度</span><div class="bar" id="acc-bar"></div>
      <div class="legend"><span><i class="dot seg-pass"></i>通过 <b id="n-pass">0</b></span><span><i class="dot seg-fail"></i>不通过 <b id="n-fail">0</b></span><span>还没验收 <b id="n-open">{len(CASES)}</b></span><span>问题已解决 <b id="n-solved">{resolved0}</b> / {len(ISSUES)}</span></div></div>
  </div>
</header>

<section class="block">
  <div class="head"><h2>启动后的样子</h2><p>在 main 上启动 Electron 后由应用自己截的整窗图（深色跟随系统）。</p></div>
  <div class="shots">
    <figure><img src="shots/demo.png" alt="AgentDeck 演示模式：顶栏、agenduck 工作区框里的 zsh 和 claude 终端、右侧源代码管理面板"><figcaption>演示模式：本仓库作为项目，框里两个真终端（zsh 跑了 git status 和 git log；claude 停在它的信任提示），右侧面板显示 main 的状态、所有 worktree 和提交记录。</figcaption></figure>
    <figure><img src="shots/reopen.png" alt="退出后重开：同样的框和两个终端，输出完整"><figcaption>退出后重开：框和窗口位置不变，tmux 里的会话接回，历史输出都在。右侧提示“isn’t in a workspace”是因为还没有聚焦窗口（IS-22）。</figcaption></figure>
  </div>
</section>

<section class="block">
  <div class="head"><h2>端到端用例</h2><p>{len(CASES)} 条，当前有问题的排在最前面。展开看前置要求、步骤和预期；在右边选验收结果，下面写备注。</p><span class="save-state" id="save-state">正在连接保存…</span></div>
  <div class="chips" role="group" aria-label="筛选用例">{chips}</div>
  <div class="cases" id="cases">{case_list}</div>
  <p class="muted" id="no-cases" hidden>没有符合筛选条件的用例。</p>
</section>

<section class="block">
  <div class="head"><h2>问题清单</h2><p>{len(ISSUES)} 条，按 P 级排列。解决一条就把处理状态改成“已解决”。</p></div>
  {issue_groups}
</section>

<section class="block">
  <div class="head"><h2>怎么验收</h2><p>按顺序试，大约 15 分钟。</p></div>
  <ol class="try">{tries}</ol>
</section>

<section class="block">
  <div class="head"><h2>建议的下一步</h2></div>
  <ol class="list">{nexts}</ol>
</section>

<details class="block collapse">
  <summary>已经实现的基础功能</summary>
  <div class="feats" style="margin-top:14px">{feats}</div>
</details>

<details class="block collapse">
  <summary>烟测和 39 项基础功能的证据</summary>
  <div class="tbl" style="margin-top:14px"><table><thead><tr><th>烟测</th><th>结果</th><th>说明</th></tr></thead><tbody>{smoke}</tbody></table></div>
  <div class="tbl" style="margin-top:14px"><table class="wide"><thead><tr><th>编号</th><th>功能</th><th>状态</th><th>自动测试</th><th>真窗口里验证</th><th>备注</th></tr></thead><tbody>{p0}</tbody></table></div>
</details>

<details class="block collapse">
  <summary>调研记录索引（{len(RESEARCH)} 条）</summary>
  <p class="muted" style="margin:10px 0 0;font-size:13px">每条的原来以为、实际情况、决策、好处和代价在《AgentDeck 调研记录》里，单击编号打开。</p>
  <div class="tbl" style="margin-top:10px"><table class="wide"><thead><tr><th>编号</th><th>分组</th><th>标题</th><th>状态</th><th>相关用例和问题</th></tr></thead><tbody>{research_rows}</tbody></table></div>
</details>
</div>

<script type="application/json" id="meta">{meta}</script>
<script>
(function () {{
  var META = JSON.parse(document.getElementById('meta').textContent);
  var saveState = document.getElementById('save-state');
  var filter = 'all';
  function $all(sel) {{ return Array.prototype.slice.call(document.querySelectorAll(sel)); }}

  function refresh() {{
    var pass = 0, fail = 0, open = 0;
    var counts = {{ all: 0, prob: 0, 'todo-acc': 0, fail: 0, pass: 0 }};
    $all('.case').forEach(function (el) {{
      var r = el.dataset.result;
      if (r === '通过') pass++; else if (r === '不通过') fail++;
      if (!r) open++;
      var m = {{ all: true, prob: el.dataset.status === 'prob', 'todo-acc': !r, fail: r === '不通过', pass: r === '通过' }};
      Object.keys(m).forEach(function (k) {{ if (m[k]) counts[k]++; }});
      el.hidden = !m[filter];
    }});
    document.getElementById('n-pass').textContent = pass;
    document.getElementById('n-fail').textContent = fail;
    document.getElementById('n-open').textContent = open;
    document.getElementById('no-cases').hidden = counts[filter] > 0;
    $all('[data-count]').forEach(function (s) {{ s.textContent = counts[s.dataset.count]; }});
    var bar = document.getElementById('acc-bar');
    bar.innerHTML = '';
    [['pass', pass], ['fail', fail], ['todo', open]].forEach(function (p) {{
      if (!p[1]) return;
      var seg = document.createElement('span');
      seg.className = 'seg seg-' + p[0];
      seg.style.flex = p[1];
      bar.appendChild(seg);
    }});
    var solved = $all('.issue').filter(function (el) {{ return el.dataset.state === '已解决'; }}).length;
    document.getElementById('n-solved').textContent = solved;
  }}

  $all('.chip').forEach(function (b) {{
    b.addEventListener('click', function () {{
      filter = b.dataset.filter;
      $all('.chip').forEach(function (x) {{ x.setAttribute('aria-pressed', String(x === b)); }});
      refresh();
    }});
  }});
  // 修改时先在页面上生效（不管能不能保存）
  $all('select.res').forEach(function (s) {{
    s.addEventListener('change', function () {{ document.getElementById(s.dataset.tc.toLowerCase()).dataset.result = s.value; refresh(); }});
  }});
  $all('select.ist').forEach(function (s) {{
    s.addEventListener('change', function () {{ document.getElementById(s.dataset.is.toLowerCase()).dataset.state = s.value; refresh(); }});
  }});
  refresh();

  function setState(text, bad) {{ saveState.textContent = text; saveState.classList.toggle('bad', !!bad); }}
  function readOnly(why) {{
    $all('select.res, select.ist, textarea').forEach(function (el) {{ el.disabled = true; }});
    setState(why, true);
  }}

  if (!window.claude || typeof window.claude.use !== 'function') {{ readOnly('这个视图保存不了验收结果（只能看）'); return; }}
  window.claude.use('db').then(function (db) {{
    if (!db) {{ readOnly('这个视图保存不了验收结果（只能看）'); return; }}
    setState('验收结果会自动保存');
    var busy = {{}}, next = {{}};
    function write(col, id, body) {{
      var key = col + '/' + id;
      if (busy[key]) {{ next[key] = body; return; }}
      busy[key] = true;
      setState('正在保存…');
      db.collection(col).doc(id).set(body).then(function () {{
        setState('已保存');
      }}, function (e) {{
        if (e && e.code === 'invalid_argument') readOnly('你没有保存权限，只能看');
        else setState('保存失败，稍后再改一次试试', true);
      }}).then(function () {{
        busy[key] = false;
        if (next[key]) {{ var b = next[key]; delete next[key]; write(col, id, b); }}
      }});
    }}
    function saveCase(id) {{
      write('acceptance', id, {{ result: document.getElementById('res-' + id).value, note: document.getElementById('note-' + id).value, at: new Date().toISOString() }});
    }}
    function saveIssue(id) {{
      write('issues', id, {{ status: document.getElementById('st-' + id).value, note: document.getElementById('isnote-' + id).value, at: new Date().toISOString() }});
    }}
    var timers = {{}};
    function debounce(key, fn) {{ clearTimeout(timers[key]); timers[key] = setTimeout(fn, 800); }}
    $all('select.res').forEach(function (s) {{ s.addEventListener('change', function () {{ saveCase(s.dataset.tc); }}); }});
    $all('textarea.tc-note').forEach(function (t) {{
      t.addEventListener('input', function () {{ debounce('c' + t.dataset.tc, function () {{ saveCase(t.dataset.tc); }}); }});
    }});
    $all('select.ist').forEach(function (s) {{ s.addEventListener('change', function () {{ saveIssue(s.dataset.is); }}); }});
    $all('textarea.is-note').forEach(function (t) {{
      t.addEventListener('input', function () {{ debounce('i' + t.dataset.is, function () {{ saveIssue(t.dataset.is); }}); }});
    }});

    function apply(snap, kind) {{
      snap.docs.forEach(function (d) {{
        var v = d.data() || {{}};
        if (kind === 'case') {{
          var sel = document.getElementById('res-' + d.id), note = document.getElementById('note-' + d.id);
          if (!sel) return;
          if (document.activeElement !== sel) sel.value = v.result || '';
          if (document.activeElement !== note) note.value = v.note || '';
          document.getElementById(d.id.toLowerCase()).dataset.result = sel.value;
        }} else {{
          var st = document.getElementById('st-' + d.id), n2 = document.getElementById('isnote-' + d.id);
          if (!st) return;
          if (document.activeElement !== st && v.status) st.value = v.status;
          if (document.activeElement !== n2 && typeof v.note === 'string') n2.value = v.note;
          document.getElementById(d.id.toLowerCase()).dataset.state = st.value;
        }}
      }});
      refresh();
    }}
    function onErr() {{ setState('读取保存的结果失败，刷新页面再试', true); }}
    db.collection('acceptance').onSnapshot(function (s) {{ apply(s, 'case'); }}, onErr);
    db.collection('issues').onSnapshot(function (s) {{ apply(s, 'issue'); }}, onErr);
  }}, function () {{ readOnly('这个视图保存不了验收结果（只能看）'); }});
}})();
</script>
'''


HTML_OUT.write_text(page(), encoding='utf-8')
print(f'P0 {P0C} · cases {CASEC} · issues {ISSUEC} → {HTML_OUT.relative_to(ROOT)}')
