const puppeteer = require('puppeteer');
const { PDFDocument, PDFArray, PDFName, PDFRawStream, PDFNumber } = require('pdf-lib');
const fs = require('fs');

let _browser = null;

async function getBrowser() {
  if (!_browser || !_browser.connected) {
    _browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return _browser;
}

async function generatePDF(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '8mm', right: '10mm', bottom: '8mm', left: '10mm' },
    });
    return pdf;
  } finally {
    await page.close();
  }
}

// The letterhead artwork embeds a ~1.4 MB print (CMYK) colour profile that every
// quotation would carry. Swap ICC-based colour spaces for their plain device
// equivalent and drop the profiles: same look on screen and office printers,
// far smaller file. Cleaned once and cached until the file changes.
let _letterhead = null; // { path, mtimeMs, bytes }

async function loadLetterhead(letterheadPath) {
  const { mtimeMs } = fs.statSync(letterheadPath);
  if (_letterhead && _letterhead.path === letterheadPath && _letterhead.mtimeMs === mtimeMs) return _letterhead.bytes;

  const doc = await PDFDocument.load(fs.readFileSync(letterheadPath));
  const ctx = doc.context;
  const device = { 1: 'DeviceGray', 3: 'DeviceRGB', 4: 'DeviceCMYK' };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFArray) || obj.size() !== 2) continue;
    if (obj.lookup(0) !== PDFName.of('ICCBased')) continue;
    const profileRef = obj.get(1);
    const profile = ctx.lookup(profileRef);
    const n = profile instanceof PDFRawStream ? profile.dict.lookup(PDFName.of('N'), PDFNumber)?.asNumber() : null;
    if (!device[n]) continue;
    ctx.assign(ref, PDFName.of(device[n]));
    ctx.delete(profileRef);
  }
  const bytes = await doc.save();
  _letterhead = { path: letterheadPath, mtimeMs, bytes };
  return bytes;
}

// Generate PDF with letterhead PDF as background on every page
async function generatePDFWithLetterhead(html, letterheadPath) {
  if (!letterheadPath || !fs.existsSync(letterheadPath)) {
    return generatePDF(html);
  }

  const browser = await getBrowser();
  const page = await browser.newPage();
  let contentBytes;
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    contentBytes = await page.pdf({
      format: 'A4',
      printBackground: true,
      omitBackground: true,
      margin: { top: '38mm', right: '10mm', bottom: '20mm', left: '10mm' },
    });
  } finally {
    await page.close();
  }

  try {
    const letterheadDoc = await PDFDocument.load(await loadLetterhead(letterheadPath));
    const contentDoc = await PDFDocument.load(contentBytes);
    const outputDoc = await PDFDocument.create();
    const pageCount = contentDoc.getPageCount();

    for (let i = 0; i < pageCount; i++) {
      const [lhPage] = await outputDoc.copyPages(letterheadDoc, [0]);
      outputDoc.addPage(lhPage);
      const [embedded] = await outputDoc.embedPdf(contentDoc, [i]);
      const outPage = outputDoc.getPage(i);
      const { width, height } = outPage.getSize();
      outPage.drawPage(embedded, { x: 0, y: 0, width, height });
    }

    return Buffer.from(await outputDoc.save());
  } catch (e) {
    console.error('Letterhead overlay failed, using plain PDF:', e.message);
    return contentBytes;
  }
}

module.exports = { generatePDF, generatePDFWithLetterhead };
