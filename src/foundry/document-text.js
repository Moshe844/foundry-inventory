'use strict';
const path=require('node:path'),{requireText}=require('../lib/util'),{ValidationError}=require('../domain/errors');
const MAX_TEXT = 24000;
// A photo or screenshot of a document is a document. It is read the same way
// an image-only PDF page is: by OCR, into text the ordinary reader then
// interprets. Before this an attached image was filed unread.
const IMAGES = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'];
const SUPPORTED = ['.pdf', '.docx', '.xlsx', '.xls', '.csv', '.tsv', '.txt', ...IMAGES];

function clean(value) { return String(value || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); }

async function renderPdfPage(page) {
  const {createCanvas}=require('@napi-rs/canvas');
  const viewport = page.getViewport({ scale: 2 });
  if(!Number.isFinite(viewport.width)||!Number.isFinite(viewport.height)||viewport.width<=0||viewport.height<=0||viewport.width>10000||viewport.height>10000||viewport.width*viewport.height>8000000)throw new ValidationError('This scanned page exceeds the safe image-processing limit. Use a smaller scan.');
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const canvasContext = canvas.getContext('2d');
  await page.render({ canvasContext, viewport, canvas }).promise;
  return canvas.toBuffer('image/png');
}

async function createOcrWorker() {
  const {createWorker}=require('tesseract.js'),englishOcr=require('@tesseract.js-data/eng');
  return createWorker(englishOcr.code, 1, {
    langPath: englishOcr.langPath,
    gzip: englishOcr.gzip,
    cacheMethod: 'readOnly',
  });
}

async function extractText(file,limits={}) {
  const filename = requireText(file.filename, 'File name', { max: 240 });
  const ext = path.extname(filename).toLowerCase();
  if (!SUPPORTED.includes(ext)) {
    throw new ValidationError('Use a PDF, Word .docx file, Excel workbook, CSV, TSV, text file, or a photo or screenshot (PNG, JPG).');
  }
  const buffer = file.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ValidationError('That document is empty.');

  let text = '';
  if (IMAGES.includes(ext)) {
    // A real image starts with its format's signature. A truncated or
    // mislabelled file is not handed to the OCR engine, which reports such
    // a file on its worker rather than to the caller.
    const signature = buffer.subarray(0, 12);
    const looksLikeImage = buffer.length > 64 && (
      signature.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      || (signature[0] === 0xff && signature[1] === 0xd8)
      || (signature.subarray(0, 4).toString('ascii') === 'RIFF' && signature.subarray(8, 12).toString('ascii') === 'WEBP')
      || signature.subarray(0, 2).toString('ascii') === 'BM'
      || signature.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || signature.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])));
    const worker = looksLikeImage ? await createOcrWorker() : null;
    try {
      if (worker) {
        const recognised = await worker.recognize(buffer);
        text = clean(recognised.data.text);
      }
    } catch {
      // A file the OCR engine cannot open — truncated, or not really an
      // image — reads as an image with nothing in it, and is said so below.
      text = '';
    } finally {
      if (worker) await worker.terminate();
    }
    if (text.length < 20) {
      throw new ValidationError('StockChief could not make out any text in that image. A clearer, straight-on photo or a screenshot of the document usually reads well.');
    }
    return text;
  }
  if (ext === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true,isEvalSupported:false,
      maxImageSize:8000000,stopAtErrors:true });
    const document = await loadingTask.promise;
    const pages = [];
    let worker = null;let ocrPages=0;
    try {
      if(limits.maxPages&&document.numPages>limits.maxPages)throw new ValidationError('This document needs a smaller page range before it can be read safely.');
      for (let number = 1; number <= document.numPages; number += 1) {
        const page = await document.getPage(number);
        // A small page can embed a huge raster. Validate its operators under
        // pdfjs's decoded-image bound even when a text layer avoids OCR.
        if(limits.maxPages)await page.getOperatorList();
        const content = await page.getTextContent();
        let pageText = clean(content.items.map((item) => item.str).join(' '));
        // Image-only pages have no usable PDF text layer. Render and OCR only
        // those pages; ordinary PDFs stay fast and preserve their exact text.
        if (pageText.length < 20) {
          if(limits.maxOcrPages&&++ocrPages>limits.maxOcrPages)throw new ValidationError('This scanned document needs a smaller page range before it can be read safely.');
          if (!worker) worker = await createOcrWorker();
          const recognised = await worker.recognize(await renderPdfPage(page));
          pageText = clean(recognised.data.text);
        }
        pages.push(pageText);
        if(limits.maxTextCharacters&&pages.reduce((n,text)=>n+text.length,0)>limits.maxTextCharacters)throw new ValidationError('This document is too long to read completely within its processing limit.');
        page.cleanup();
      }
    } finally {
      if (worker) await worker.terminate();
      await loadingTask.destroy();
    }
    text = pages.join('\n\n');
  } else if (ext === '.docx') {
    text = (await require('mammoth').extractRawText({ buffer })).value;
  } else if (['.xlsx', '.xls'].includes(ext)) {
    const XLSX=require('xlsx');
    const book = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    text = book.SheetNames.map((name) => {
      const rows = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: '' });
      return `Sheet: ${name}\n${rows.map((row) => row.join(' | ')).join('\n')}`;
    }).join('\n\n');
  } else text = buffer.toString('utf8');

  text = clean(text);
  if(limits.maxTextCharacters&&text.length>limits.maxTextCharacters)throw new ValidationError('This document is too long to read completely within its processing limit.');
  if (text.length < 20) throw new ValidationError('StockChief could not find readable inventory text in that document. Try a clearer scan or a higher-resolution copy.');
  return limits.maxTextCharacters ? text : text.slice(0, MAX_TEXT);
}

module.exports={SUPPORTED,clean,extractText,renderPdfPage,createOcrWorker};
