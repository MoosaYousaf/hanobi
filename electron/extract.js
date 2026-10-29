const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

// Plain text out of project documents for API models. It uses only macOS tools, so there are no new dependencies:
// PDFKit through JXA for PDF, textutil for Word, RTF, and OpenDocument, and unzip for PowerPoint and Excel XML.
const TEXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|sql|ini|cfg|log|tex|rst|org)$/i;
const TEXTUTIL = /\.(docx?|rtf|odt|wordml)$/i;
const OFFICE_ZIP = /\.(pptx|xlsx)$/i;
const MAX_OUTPUT = 64 * 1024 * 1024;

function run(command, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT, timeout }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve(stdout);
    });
  });
}

const PDF_SCRIPT = `ObjC.import('PDFKit');
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (doc.isNil()) return '';
  const pages = [];
  for (let i = 0; i < doc.pageCount; i++) { const text = doc.pageAtIndex(i).string; pages.push(text.isNil() ? '' : text.js); }
  return pages.join('\\f');
}`;

async function pdf(file) {
  const pages = (await run('osascript', ['-l', 'JavaScript', '-e', PDF_SCRIPT, file], 120000)).replace(/\n$/, '').split('\f');
  // A scan has no text layer: return nothing, so the document is listed by name only.
  return pages.some(text => text.trim()) ? pages.map((text, i) => `[Page ${i + 1}]\n${text.trim()}`).join('\n\n') : '';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e] ?? m);
const texts = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))].map(m => decode(m[1]));
const numbered = (names, pattern) => names.filter(n => pattern.test(n)).sort((a, b) => +a.match(/(\d+)\.xml$/)[1] - +b.match(/(\d+)\.xml$/)[1]);
const entry = (file, name) => run('unzip', ['-p', file, name]);

async function pptx(file, names) {
  const slides = [];
  for (const name of numbered(names, /^ppt\/slides\/slide\d+\.xml$/)) {
    const paragraphs = (await entry(file, name)).split(/<\/a:p>/).map(p => texts(p, 'a:t').join('')).filter(p => p.trim());
    slides.push(`[Slide ${slides.length + 1}]\n${paragraphs.join('\n')}`);
  }
  return slides.join('\n\n');
}

// One tab-separated line per row. Shared strings are looked up; formulas give their cached value.
async function xlsx(file, names) {
  const shared = names.includes('xl/sharedStrings.xml')
    ? (await entry(file, 'xl/sharedStrings.xml')).split(/<\/si>/).slice(0, -1).map(si => texts(si, 't').join('')) : [];
  const sheetNames = names.includes('xl/workbook.xml') ? [...(await entry(file, 'xl/workbook.xml')).matchAll(/<sheet\s[^>]*name="([^"]*)"/g)].map(m => decode(m[1])) : [];
  const sheets = [];
  for (const name of numbered(names, /^xl\/worksheets\/sheet\d+\.xml$/)) {
    const rows = [];
    for (const [, row] of (await entry(file, name)).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(([, attrs, body = '']) => {
        const type = attrs.match(/\bt="(\w+)"/)?.[1];
        if (type === 'inlineStr') return texts(body, 't').join('');
        const value = texts(body, 'v')[0] ?? '';
        return type === 's' ? shared[+value] ?? '' : value;
      });
      if (cells.some(Boolean)) rows.push(cells.join('\t'));
    }
    sheets.push(`[Sheet: ${sheetNames[sheets.length] || sheets.length + 1}]\n${rows.join('\n')}`);
  }
  return sheets.join('\n\n');
}

// Returns the text, or null when the type is not supported.
async function extractText(file) {
  if (TEXT.test(file)) return fs.readFile(file, 'utf8');
  if (/\.pdf$/i.test(file)) return pdf(file);
  if (TEXTUTIL.test(file)) return run('textutil', ['-convert', 'txt', '-stdout', file]);
  if (OFFICE_ZIP.test(file)) {
    const names = (await run('unzip', ['-Z1', file])).split('\n');
    return /\.pptx$/i.test(file) ? pptx(file, names) : xlsx(file, names);
  }
  return null;
}

const supported = file => TEXT.test(file) || /\.pdf$/i.test(file) || TEXTUTIL.test(file) || OFFICE_ZIP.test(file);

// Extracted text is kept in <folder>/.text/<name>.txt and made again when the document is newer.
async function cachedText(folder, name) {
  const source = path.join(folder, name);
  if (TEXT.test(name)) return fs.readFile(source, 'utf8');
  if (!supported(name)) return null;
  const cache = path.join(folder, '.text', `${name}.txt`);
  const [src, out] = await Promise.all([fs.stat(source), fs.stat(cache).catch(() => null)]);
  if (out && out.mtimeMs >= src.mtimeMs) return fs.readFile(cache, 'utf8');
  const text = (await extractText(source)).trim();
  await fs.mkdir(path.dirname(cache), { recursive: true });
  await fs.writeFile(cache, text);
  return text;
}

module.exports = { extractText, cachedText, supported };
