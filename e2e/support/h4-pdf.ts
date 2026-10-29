// IS-124 用：在沙盒里写一个小的多页 PDF（不依赖别的包）。
// 每页顶上一行大字 “Page N”，下面 N 条粗黑条（截图里一眼看出是第几页）。
import { writeFileSync } from 'node:fs';

/** 写一个 pages 页的 PDF 到 file。 */
export function writePdf(file: string, pages: number): void {
  const objects: string[] = [];
  // 1 Catalog、2 Pages、3 Font，之后每页两个对象（Page、Contents）
  const pageIds = Array.from({ length: pages }, (_, i) => 4 + i * 2);
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let n = 1; n <= pages; n++) {
    const bars = Array.from({ length: n }, (_, i) => `60 ${560 - i * 60} 492 36 re f`).join('\n');
    const stream = `BT /F1 96 Tf 60 660 Td (Page ${n}) Tj ET\n${bars}\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[n - 1]! + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(file, out, 'latin1');
}
