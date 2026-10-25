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

// Writing area inside the letterhead: A4 minus the margins below. The letterhead's
// header ends at 24 mm and its footer starts at 272 mm; its text starts 12.6 mm in.
const LH_MARGIN = { top: 29, right: 12, bottom: 28, left: 12 };   // mm
const MM = 96 / 25.4;                                            // CSS px per mm

// Generate PDF with letterhead PDF as background on every page.
// fitOnePage: if the content is a bit taller than one page, shrink it (never
// below minScale) so it fits on one page; content that needs more than that
// shrink prints normally across several pages instead.
async function generatePDFWithLetterhead(html, letterheadPath, { fitOnePage = false, minScale = 0.5 } = {}) {
  if (!letterheadPath || !fs.existsSync(letterheadPath)) {
    return generatePDF(html);
  }

  const browser = await getBrowser();
  const page = await browser.newPage();
  let contentBytes;
  try {
    const areaW = (210 - LH_MARGIN.left - LH_MARGIN.right) * MM;
    const areaH = (297 - LH_MARGIN.top - LH_MARGIN.bottom) * MM;
    await page.setViewport({ width: Math.round(areaW), height: Math.round(areaH) });
    await page.emulateMediaType('print');
    await page.setContent(html, { waitUntil: 'networkidle0' });
    let scale = 1, onePage = false;
    const { w, h } = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.body.scrollHeight }));
    // Never let content run past the right margin (it would be cut off): shrink to the width
    const widthFit = Math.min(1, areaW / w);
    if (fitOnePage) {
      const fit = Math.min(widthFit, (areaH - 4) / h);
      if (fit >= 1) onePage = true;
      else if (fit >= minScale) { scale = fit; onePage = true; }
      else scale = widthFit;
    } else {
      scale = widthFit;
    }
    contentBytes = await page.pdf({
      format: 'A4',
      printBackground: true,
      omitBackground: true,
      scale,
      margin: { top: LH_MARGIN.top + 'mm', right: LH_MARGIN.right + 'mm', bottom: LH_MARGIN.bottom + 'mm', left: LH_MARGIN.left + 'mm' },
      ...(onePage ? { pageRanges: '1' } : {}),
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
