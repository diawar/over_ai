import json
import sys
from pathlib import Path
import pypdfium2 as pdfium

root = Path(__file__).resolve().parents[1] / 'data/cooling-source-cache-20261028'
index = json.loads((root / 'index.json').read_text(encoding='utf-8'))
for url, record in index.items():
    if any(term in url.lower() for term in ('csr.asus', 'slavery', 'ce-000', 'ukca-', '/datasheet/')):
        continue
    if len(sys.argv) > 1 and not any(term in url for term in sys.argv[1:]):
        continue
    if record.get('status') != 200 or not record.get('file', '').endswith('.pdf'):
        continue
    output = root / (record['file'] + '.txt')
    if output.exists():
        continue
    try:
        print(f'READING {url}', flush=True)
        reader = pdfium.PdfDocument(str(root / record['file']))
        output.write_text('\n'.join(f'\nPAGE {n+1}\n' + reader[n].get_textpage().get_text_range()
                                  for n in range(len(reader))), encoding='utf-8')
        print(f'EXTRACTED {record["file"]}: {len(reader)} pages', flush=True)
    except Exception as error:
        print(f'FAILED {record["file"]}: {type(error).__name__}')
