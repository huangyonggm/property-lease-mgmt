"""
dump 合同模板（含普票）.docx 的完整结构：段落 + 表格 + 占位符
纯标准库实现（zipfile + xml.etree），不依赖 python-docx
"""
import zipfile, re, sys, json
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'

def para_text(p):
    """按 w:t 拼接段落文本，正确跳过 pPr 里的属性节点"""
    out = []
    for r in p.iter():
        if r.tag == W + 't':
            out.append(r.text or '')
        elif r.tag == W + 'tab':
            out.append('\t')
        elif r.tag == W + 'br':
            out.append('\n')
    return ''.join(out)

def para_bold(p):
    """段落是否含加粗 run（用于识别章节标题）"""
    for r in p.iter(W + 'b'):
        return True
    return False

def main(path):
    z = zipfile.ZipFile(path)
    xml = z.read('word/document.xml')
    root = ET.fromstring(xml)
    body = root.find(W + 'body')

    items = []   # {type:'p'|'tbl', ...}
    for el in body:
        if el.tag == W + 'p':
            t = para_text(el)
            items.append({'type': 'p', 'text': t, 'bold': para_bold(el)})
        elif el.tag == W + 'tbl':
            rows = []
            for tr in el.findall(W + 'tr'):
                cells = []
                for tc in tr.findall(W + 'tc'):
                    ct = ''.join(para_text(p) for p in tc.findall(W + 'p'))
                    cells.append(ct.strip())
                rows.append(cells)
            items.append({'type': 'tbl', 'rows': rows})

    print('=' * 70)
    print('模板：', path)
    print('顶层元素：%d 个（段落 %d / 表格 %d）' % (
        len(items),
        sum(1 for i in items if i['type'] == 'p'),
        sum(1 for i in items if i['type'] == 'tbl')))
    print('=' * 70)

    # 占位符统计：*** 或 ****** 或 ____
    alltext = []
    for i, it in enumerate(items):
        if it['type'] == 'p':
            alltext.append(it['text'])
            mark = '【标题】' if it['bold'] and it['text'].strip() else ''
            if it['text'].strip():
                print('[P%03d] %s %s' % (i, mark, it['text']))
        else:
            print('[T%03d] 表格 %d 行 × %d 列' % (i, len(it['rows']),
                  max((len(r) for r in it['rows']), default=0)))
            for ri, r in enumerate(it['rows']):
                print('        R%02d | %s' % (ri, ' | '.join(r)))

    full = '\n'.join(alltext)
    print()
    print('=' * 70)
    print('占位符（模板里需要填的槽位）')
    print('=' * 70)
    pats = {
        '星号串 ******': r'\*{2,}',
        '下划线 ____': r'_{2,}',
        '方括号【】': r'【[^】]*】',
        '书名号《》': r'《[^》]*》',
        '中文括号（）': r'（[^）]{0,40}）',
    }
    for name, p in pats.items():
        m = re.findall(p, full)
        print('  %-16s %3d 处  %s' % (name, len(m), m[:8]))

    with open('docs/_template_dump.json', 'w', encoding='utf-8') as f:
        json.dump({'items': items, 'fullText': full}, f, ensure_ascii=False, indent=1)
    print('\n完整结构已存 docs/_template_dump.json')

if __name__ == '__main__':
    main(sys.argv[1])
