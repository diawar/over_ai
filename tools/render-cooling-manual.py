import json
import sys
from pathlib import Path
import pypdfium2 as pdfium
from PIL import Image

root = Path(__file__).resolve().parents[1] / 'data/cooling-source-cache-20261028'
index = json.loads((root / 'index.json').read_text(encoding='utf-8'))
url = next(url for url in index if sys.argv[1] in url and index[url].get('status') == 200)
record = index[url]
document = pdfium.PdfDocument(str(root / record['file']))
pages = [int(value) for value in sys.argv[2:]] or list(range(max(0, len(document)-8), len(document)))
images = [document[number].render(scale=1.5).to_pil().convert('RGB') for number in pages]
width = max(image.width for image in images)
sheet = Image.new('RGB', (width, sum(image.height for image in images)), 'white')
top = 0
for image in images:
    sheet.paste(image, (0, top)); top += image.height
output = root / (record['file'] + '-pages-' + '-'.join(map(str, pages)) + '.png')
sheet.save(output)
print(str(output))
