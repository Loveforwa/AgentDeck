# 生成 docs/status/AgentDeck-端到端用例与问题清单-<日期>.xlsx。用法：python3 docs/status/build_xlsx.py <输出路径>（需要 openpyxl）
import sys
from pathlib import Path
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import FormulaRule

OUT = sys.argv[1]

# 调研记录（docs/research/entries.py）：用来算“相关调研”，并放进「调研记录」表
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'research'))
from entries import ENTRIES as RESEARCH, STAGES  # noqa: E402

# 2026-10-24 统一编号前的旧编号
OLD_ISSUE = {v: k for k, v in {**{f'Q{n:02d}': f'IS-{n:02d}' for n in range(1, 35)}, 'Q36': 'IS-35', 'Q37': 'IS-36', 'Q38': 'IS-37', 'Q39': 'IS-38'}.items()}


def old_case(tc):
    return 'E' + tc[3:]


def research_for(ref):
    """引用了这个用例或问题的调研记录编号。"""
    return ' '.join(e['id'] for e in RESEARCH if ref in e['cases'] or ref in e['issues'])
FONT = 'Arial'

# 用例和问题的数据在 tracking.py
sys.path.insert(0, str(Path(__file__).resolve().parent))
from tracking import CASES, ISSUES, RESOLVED  # noqa: E402

thin = Side(style='thin', color='D9D9D4')
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)
HEAD_FILL = PatternFill('solid', fgColor='1A1A1A')
HEAD_FONT = Font(name=FONT, bold=True, color='FFFFFF', size=11)
BODY_FONT = Font(name=FONT, size=10)
BOLD = Font(name=FONT, size=10, bold=True)
INPUT_FILL = PatternFill('solid', fgColor='FFF7D6')   # 用户填写
PROBLEM_FILL = PatternFill('solid', fgColor='FBE3D6') # 当前有问题
WRAP_TOP = Alignment(wrap_text=True, vertical='top')
CENTER = Alignment(horizontal='center', vertical='top', wrap_text=True)

STATUS_FILL = {
    '⚠ 当前有问题': PatternFill('solid', fgColor='C2410C'),
    '未验证': PatternFill('solid', fgColor='E7E6E1'),
    '部分验证': PatternFill('solid', fgColor='F3E6B8'),
    '已验证': PatternFill('solid', fgColor='CFE5D6'),
    '未实现': PatternFill('solid', fgColor='EFEFEF'),
}
P_FILL = {
    'P0': PatternFill('solid', fgColor='C2410C'),
    'P1': PatternFill('solid', fgColor='E9A57E'),
    'P2': PatternFill('solid', fgColor='F3E6B8'),
    'P3': PatternFill('solid', fgColor='E7E6E1'),
}

wb = Workbook()

# ---------- 说明 ----------
ws = wb.active
ws.title = '说明'
rows = [
    ('AgentDeck MVP 端到端用例与问题清单', None),
    ('生成时间', '2026-10-24，基于 main。证据来自各包测试、apps/desktop/ASSEMBLY_NOTES.md、2026-10-23 的组装和两次启动截图；当天下午统一了编号，并修了 IS-37、IS-38。'),
    ('', None),
    ('怎么用', None),
    ('1', '先看「端到端用例」：排在最前面、标着“⚠ 当前有问题”的是已知会出问题的用例，问题写在“当前问题”列。'),
    ('2', '按“前置要求 → 操作步骤”去试，对照“UI / 后台预期表现”和“最终效果”判断，在黄色的“验收结果”“验收备注”两列填写。'),
    ('3', '「问题清单」按 P 级排好了，解决一条就把“处理状态”改成“已解决”，「汇总」会自动更新。'),
    ('', None),
    ('需要你填的列', '黄色底的列：端到端用例的“验收结果”“验收备注”；问题清单的“处理状态”“处理备注”。其他列不用改。'),
    ('验收结果怎么填', '通过 / 不通过 / 阻塞（前置条件做不到）/ 跳过。下拉可选。'),
    ('', None),
    ('用例状态的含义', None),
    ('⚠ 当前有问题', '已经知道这个流程里有缺陷或和需求不一致，问题写在“当前问题”列'),
    ('未验证', '功能写了、有自动测试，但没在真的应用窗口里走过'),
    ('部分验证', '流程里有几步在真窗口里试过，其余没有'),
    ('已验证', '2026-10-23 组装时在真窗口里走通过'),
    ('未实现', '属于 MVP 完整版（P1 功能），还没做'),
    ('', None),
    ('P 级的含义', None),
    ('P0', '阻塞 MVP 验收：不修好或不验证完，就不能说基础 MVP 完成'),
    ('P1', '影响主要流程的正确性或可用性，有绕过办法，MVP 交付前要处理'),
    ('P2', '次要体验、完整性、性能测量，MVP 之后可以做'),
    ('P3', '工程卫生、清理'),
    ('', None),
    ('编号规则', None),
    ('TC-xx', '端到端用例。TC-01 到 TC-14 和设计画布「10 · 全局规则」里的 14 条验收场景一一对应，TC-15 起是补充的用例。'),
    ('IS-xx', '问题清单里的问题（缺陷、未验证、缺失、技术债等），编号只表示登记顺序，轻重看 P 级。'),
    ('DR-xx', '调研记录（docs/research-log.md 和网页版《AgentDeck 调研记录》）：哪里和最初设想不一样、怎么决定的。每条用例和问题的“相关调研”列指向它；「调研记录」表是全部 44 条的索引。'),
    ('F1、T2、X3…', 'MVP 任务表里的任务编号（分支名和提交信息里用的），不变。'),
    ('旧编号', '2026-10-24 统一前，用例叫 E01–E24、问题叫 Q01–Q39、调研叫 A1–F3；每张表最后一列保留了旧编号，方便对照之前的提交和聊天记录。'),
    ('', None),
    ('示例填写', '端到端用例 TC-21（已验证）一行里，“验收结果”可以填“通过”，“验收备注”写“在 ~ 里打开，输出正常”。'),
]
for r, (a, b) in enumerate(rows, 1):
    ws.cell(r, 1, a)
    if b is not None:
        ws.cell(r, 2, b)
    for c in (1, 2):
        cell = ws.cell(r, c)
        cell.font = BODY_FONT
        cell.alignment = WRAP_TOP
ws['A1'].font = Font(name=FONT, size=16, bold=True)
for r in (4, 12, 19, 25):
    ws.cell(r, 1).font = Font(name=FONT, size=12, bold=True)
for r in range(13, 18):
    ws.cell(r, 1).fill = STATUS_FILL[ws.cell(r, 1).value]
    if ws.cell(r, 1).value == '⚠ 当前有问题':
        ws.cell(r, 1).font = Font(name=FONT, size=10, bold=True, color='FFFFFF')
for r in range(20, 24):
    ws.cell(r, 1).fill = P_FILL[ws.cell(r, 1).value]
    ws.cell(r, 1).font = Font(name=FONT, size=10, bold=True, color='FFFFFF' if ws.cell(r, 1).value in ('P0',) else '1A1A1A')
ws.cell(9, 2).fill = INPUT_FILL
for r in (2, 9, 10, 26, 27, 28, 29, 30, 32):
    ws.cell(r, 1).font = BOLD
ws.column_dimensions['A'].width = 18
ws.column_dimensions['B'].width = 110

# ---------- 端到端用例 ----------
ws = wb.create_sheet('端到端用例')
heads = ['用例编号', '优先级', '当前状态', '业务场景', '前置要求', '操作步骤', 'UI / 后台预期表现', '最终效果', '当前问题', '关联问题', '验收结果', '验收备注', '相关调研', '旧编号']
widths = [10, 8, 14, 30, 30, 38, 60, 26, 46, 14, 12, 30, 16, 9]
for c, (h, w) in enumerate(zip(heads, widths), 1):
    cell = ws.cell(1, c, h)
    cell.font = HEAD_FONT
    cell.fill = HEAD_FILL
    cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    cell.border = BORDER
    ws.column_dimensions[get_column_letter(c)].width = w
for c in (11, 12):
    ws.cell(1, c).fill = PatternFill('solid', fgColor='8A6D1F')

for r, k in enumerate(CASES, 2):
    vals = [k['id'], k['p'], k['status'], k['scene'], k['pre'], k['steps'], k['expect'], k['result'], k['issue'], k['rel'], None, None,
            research_for(k['id']), old_case(k['id'])]
    for c, v in enumerate(vals, 1):
        cell = ws.cell(r, c, v)
        cell.font = BODY_FONT
        cell.alignment = WRAP_TOP
        cell.border = BORDER
    ws.cell(r, 1).font = BOLD
    for c in (1, 2, 3, 10, 11, 13, 14):
        ws.cell(r, c).alignment = CENTER
    ws.cell(r, 14).font = Font(name=FONT, size=10, color='6B6B66')
    st = ws.cell(r, 3)
    st.fill = STATUS_FILL[k['status']]
    if k['status'] == '⚠ 当前有问题':
        st.font = Font(name=FONT, size=10, bold=True, color='FFFFFF')
        ws.cell(r, 9).fill = PROBLEM_FILL
        ws.cell(r, 9).font = Font(name=FONT, size=10, color='8A2B07')
    pc = ws.cell(r, 2)
    pc.fill = P_FILL[k['p']]
    pc.font = Font(name=FONT, size=10, bold=True, color='FFFFFF' if k['p'] == 'P0' else '1A1A1A')
    for c in (11, 12):
        ws.cell(r, c).fill = INPUT_FILL
last_case = len(CASES) + 1
ws.freeze_panes = 'D2'
ws.auto_filter.ref = f'A1:N{last_case}'
dv = DataValidation(type='list', formula1='"通过,不通过,阻塞,跳过"', allow_blank=True)
ws.add_data_validation(dv)
dv.add(f'K2:K{last_case}')
# 验收结果填“不通过”时整行标红
ws.conditional_formatting.add(f'K2:K{last_case}', FormulaRule(formula=['$K2="不通过"'], fill=PatternFill('solid', fgColor='F4C7C3')))
ws.conditional_formatting.add(f'K2:K{last_case}', FormulaRule(formula=['$K2="通过"'], fill=PatternFill('solid', fgColor='CFE5D6')))

# ---------- 问题清单 ----------
ws2 = wb.create_sheet('问题清单')
heads2 = ['问题编号', 'P 级', '类型', '所属模块', '问题描述', '怎么复现 / 怎么验证', '影响', '建议处理', '关联用例', '处理状态', '处理备注', '相关调研', '旧编号']
widths2 = [10, 8, 12, 22, 60, 36, 32, 40, 14, 12, 30, 16, 9]
for c, (h, w) in enumerate(zip(heads2, widths2), 1):
    cell = ws2.cell(1, c, h)
    cell.font = HEAD_FONT
    cell.fill = HEAD_FILL
    cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    cell.border = BORDER
    ws2.column_dimensions[get_column_letter(c)].width = w
for c in (10, 11):
    ws2.cell(1, c).fill = PatternFill('solid', fgColor='8A6D1F')
order = {'P0': 0, 'P1': 1, 'P2': 2, 'P3': 3}
issues = sorted(ISSUES, key=lambda x: (order[x[1]], x[0]))
for r, row in enumerate(issues, 2):
    vals = list(row) + ['待处理', None, research_for(row[0]), OLD_ISSUE.get(row[0], '')]
    for c, v in enumerate(vals, 1):
        cell = ws2.cell(r, c, v)
        cell.font = BODY_FONT
        cell.alignment = WRAP_TOP
        cell.border = BORDER
    ws2.cell(r, 1).font = BOLD
    for c in (1, 2, 3, 9, 10, 12, 13):
        ws2.cell(r, c).alignment = CENTER
    ws2.cell(r, 13).font = Font(name=FONT, size=10, color='6B6B66')
    pc = ws2.cell(r, 2)
    pc.fill = P_FILL[row[1]]
    pc.font = Font(name=FONT, size=10, bold=True, color='FFFFFF' if row[1] == 'P0' else '1A1A1A')
    for c in (10, 11):
        ws2.cell(r, c).fill = INPUT_FILL
last_issue = len(issues) + 1
ws2.freeze_panes = 'C2'
ws2.auto_filter.ref = f'A1:M{last_issue}'
dv2 = DataValidation(type='list', formula1='"待处理,处理中,已解决,不处理"', allow_blank=False)
ws2.add_data_validation(dv2)
dv2.add(f'J2:J{last_issue}')
ws2.conditional_formatting.add(f'J2:J{last_issue}', FormulaRule(formula=['$J2="已解决"'], fill=PatternFill('solid', fgColor='CFE5D6')))

# ---------- 调研记录（索引） ----------
ws4 = wb.create_sheet('调研记录')
RS_STATUS = {'done': '已解决', 'partial': '进行中', 'deferred': '推迟', 'pending': '待验证'}
stage_name = {sid: name for sid, name, _ in STAGES}
heads4 = ['调研编号', '分组', '标题', '状态', '决策', '相关用例', '相关问题', '旧编号']
widths4 = [10, 14, 44, 10, 70, 18, 22, 9]
for c, (h, w) in enumerate(zip(heads4, widths4), 1):
    cell = ws4.cell(1, c, h)
    cell.font = HEAD_FONT
    cell.fill = HEAD_FILL
    cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    cell.border = BORDER
    ws4.column_dimensions[get_column_letter(c)].width = w
for r, e in enumerate(RESEARCH, 2):
    vals = [e['id'], stage_name[e['stage']], e['title'], RS_STATUS[e['status']], e['decision'],
            ' '.join(e['cases']), ' '.join(e['issues']), e['old']]
    for c, v in enumerate(vals, 1):
        cell = ws4.cell(r, c, v)
        cell.font = BODY_FONT
        cell.alignment = WRAP_TOP
        cell.border = BORDER
    ws4.cell(r, 1).font = BOLD
    for c in (1, 2, 4, 6, 7, 8):
        ws4.cell(r, c).alignment = CENTER
    ws4.cell(r, 8).font = Font(name=FONT, size=10, color='6B6B66')
ws4.freeze_panes = 'C2'
ws4.auto_filter.ref = f'A1:H{len(RESEARCH) + 1}'

# ---------- 汇总（公式） ----------
ws3 = wb.create_sheet('汇总')
ws3['A1'] = '汇总'
ws3['A1'].font = Font(name=FONT, size=14, bold=True)
ws3['A2'] = '下面的数字都是公式，改了另外两张表会自动更新。'
ws3['A2'].font = Font(name=FONT, size=10, color='6B6B66')

def head(row, labels):
    for c, h in enumerate(labels, 1):
        cell = ws3.cell(row, c, h)
        cell.font = HEAD_FONT
        cell.fill = HEAD_FILL
        cell.alignment = Alignment(horizontal='center')
        cell.border = BORDER

C = f"'端到端用例'!$C$2:$C${last_case}"
K = f"'端到端用例'!$K$2:$K${last_case}"
B = f"'端到端用例'!$B$2:$B${last_case}"
head(4, ['用例状态', '用例数', '已验收通过', '验收不通过'])
r = 5
for s in ['⚠ 当前有问题', '未验证', '部分验证', '已验证', '未实现']:
    ws3.cell(r, 1, s)
    ws3.cell(r, 2, f'=COUNTIF({C},A{r})')
    ws3.cell(r, 3, f'=COUNTIFS({C},A{r},{K},"通过")')
    ws3.cell(r, 4, f'=COUNTIFS({C},A{r},{K},"不通过")')
    r += 1
ws3.cell(r, 1, '合计')
for c, col in ((2, 'B'), (3, 'C'), (4, 'D')):
    ws3.cell(r, c, f'=SUM({col}5:{col}{r-1})')
total_case_row = r
for rr in range(5, r + 1):
    for c in range(1, 5):
        ws3.cell(rr, c).font = BOLD if rr == r else BODY_FONT
        ws3.cell(rr, c).border = BORDER
        if c > 1:
            ws3.cell(rr, c).alignment = Alignment(horizontal='center')

P = f"'问题清单'!$B$2:$B${last_issue}"
J = f"'问题清单'!$J$2:$J${last_issue}"
start = total_case_row + 2
head(start, ['问题 P 级', '问题数', '已解决', '未解决'])
r = start + 1
for p in ['P0', 'P1', 'P2', 'P3']:
    ws3.cell(r, 1, p)
    ws3.cell(r, 2, f'=COUNTIF({P},A{r})')
    ws3.cell(r, 3, f'=COUNTIFS({P},A{r},{J},"已解决")')
    ws3.cell(r, 4, f'=B{r}-C{r}')
    ws3.cell(r, 1).fill = P_FILL[p]
    r += 1
ws3.cell(r, 1, '合计')
for c, col in ((2, 'B'), (3, 'C'), (4, 'D')):
    ws3.cell(r, c, f'=SUM({col}{start+1}:{col}{r-1})')
for rr in range(start + 1, r + 1):
    for c in range(1, 5):
        ws3.cell(rr, c).font = BOLD if rr == r else BODY_FONT
        ws3.cell(rr, c).border = BORDER
        if c > 1:
            ws3.cell(rr, c).alignment = Alignment(horizontal='center')
ws3.cell(start + 1, 1).font = Font(name=FONT, size=10, bold=True, color='FFFFFF')

s2 = r + 2
head(s2, ['用例优先级', '用例数', '已验收通过', '未通过或未验收'])
r = s2 + 1
for p in ['P0', 'P1', 'P2']:
    ws3.cell(r, 1, p)
    ws3.cell(r, 2, f'=COUNTIF({B},A{r})')
    ws3.cell(r, 3, f'=COUNTIFS({B},A{r},{K},"通过")')
    ws3.cell(r, 4, f'=B{r}-C{r}')
    ws3.cell(r, 1).fill = P_FILL[p]
    for c in range(1, 5):
        ws3.cell(r, c).font = BODY_FONT
        ws3.cell(r, c).border = BORDER
        if c > 1:
            ws3.cell(r, c).alignment = Alignment(horizontal='center')
    r += 1
ws3.cell(s2 + 1, 1).font = Font(name=FONT, size=10, bold=True, color='FFFFFF')
for col, w in zip('ABCD', (18, 12, 14, 16)):
    ws3.column_dimensions[col].width = w

for r in range(2, last_issue + 1):
    note = RESOLVED.get(ws2.cell(r, 1).value)
    if note:
        ws2.cell(r, 10).value = '已解决'
        ws2.cell(r, 11).value = note

# 没有 LibreOffice 可以预先算好公式，打开时让 Excel / Numbers / WPS 全部重算
wb.calculation.fullCalcOnLoad = True
wb.save(OUT)
print('cases', len(CASES), 'issues', len(ISSUES), '->', OUT)
# 供核对：公式应得出的数字
from collections import Counter
print('用例状态', dict(Counter(k['status'] for k in CASES)))
print('用例优先级', dict(Counter(k['p'] for k in CASES)))
print('问题 P 级', dict(Counter(i[1] for i in ISSUES)))
