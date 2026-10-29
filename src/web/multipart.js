'use strict';

/**
 * Reading an uploaded file off the request.
 *
 * Express parses forms and JSON but not file uploads, and the usual answer is a
 * dependency. This is the whole of what StockChief needs from one: split the body
 * on its boundary, keep the fields as fields and the files as buffers, and stop
 * at a size limit. Binary-safe throughout — the parts are sliced as Buffers and
 * never turned into strings, because an .xlsx is a zip and would not survive it.
 *
 * The ordinary fields land in `req.body` exactly as a normal form would, which
 * matters: CSRF checking is the same code path for an upload as for a button.
 */

const DEFAULT_LIMIT = 512 * 1024 * 1024;
const MAX_PARTS = 1100;
// A system switch commonly needs separate exports for products, stock,
// suppliers, customers, open orders and rules. The total byte ceiling remains
// the safety boundary; silently dropping the fifth file would corrupt scope.
const MAX_FILES = 500;

const CRLF = Buffer.from('\r\n');
const DOUBLE_CRLF = Buffer.from('\r\n\r\n');

function boundaryOf(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) return null;
  return (match[1] || match[2] || '').trim();
}

/** `form-data; name="file"; filename="stock.xlsx"` → its pieces. */
function parseDisposition(header) {
  const name = /name="([^"]*)"/i.exec(header);
  const filename = /filename\*?=(?:UTF-8'')?"?([^";]*)"?/i.exec(header);
  return {
    name: name ? name[1] : null,
    // Only the basename: a filename is display text, never a path StockChief follows.
    filename: filename ? decodeURIComponent(filename[1] || '').split(/[\\/]/).pop() : null,
  };
}

function splitParts(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let index = body.indexOf(delimiter);
  if (index === -1) return parts;

  index += delimiter.length;
  while (index < body.length && parts.length < MAX_PARTS) {
    // "--" here marks the closing boundary; anything else is a CRLF then a part.
    if (body[index] === 0x2d && body[index + 1] === 0x2d) break;
    if (body.slice(index, index + 2).equals(CRLF)) index += 2;

    const next = body.indexOf(delimiter, index);
    if (next === -1) break;
    // The CRLF immediately before the next boundary belongs to the delimiter.
    parts.push(body.slice(index, Math.max(index, next - CRLF.length)));
    index = next + delimiter.length;
  }
  return parts;
}

function parseBody(body, boundary, { maxFiles = MAX_FILES } = {}) {
  const fields = {};
  const files = [];

  for (const part of splitParts(body, boundary)) {
    const split = part.indexOf(DOUBLE_CRLF);
    if (split === -1) continue;
    const headerText = part.slice(0, split).toString('utf8');
    const content = part.slice(split + DOUBLE_CRLF.length);

    const disposition = /content-disposition:([^\r\n]*)/i.exec(headerText);
    if (!disposition) continue;
    const { name, filename } = parseDisposition(disposition[1]);
    if (!name) continue;

    if (filename !== null && filename !== undefined) {
      if (filename === '') continue;
      if (files.length >= maxFiles) {
        const error = new Error(`Choose no more than ${maxFiles} files in one upload.`);
        error.status = 413;
        throw error;
      }
      const contentType = /content-type:\s*([^\r\n]+)/i.exec(headerText);
      files.push({ field: name, filename, mimeType: contentType ? contentType[1].trim().toLowerCase() : null,
        size: content.length, buffer: content });
      continue;
    }

    const value = content.toString('utf8');
    // Repeated names become an array, matching how express.urlencoded behaves.
    if (fields[name] === undefined) fields[name] = value;
    else if (Array.isArray(fields[name])) fields[name].push(value);
    else fields[name] = [fields[name], value];
  }

  return { fields, files };
}

/**
 * Middleware. Does nothing at all unless the request is multipart.
 */
const parsedMultipart=Symbol('stockchief.parsedMultipart');
let reservedUploadBytes=0;
function multipart({ limit = DEFAULT_LIMIT, maxFiles = MAX_FILES, memoryBudgetBytes = Number(process.env.FOUNDRY_UPLOAD_MEMORY_BUDGET_BYTES)||DEFAULT_LIMIT } = {}) {
  if(!Number.isSafeInteger(memoryBudgetBytes)||memoryBudgetBytes<1)throw new Error('Upload memory budget must be a positive integer.');
  return function multipartMiddleware(req, res, next) {
    const type = req.get('content-type') || '';
    if (!type.toLowerCase().startsWith('multipart/form-data')) return next();

    const parsed=req[parsedMultipart];if(parsed){if(parsed.received>limit||parsed.fileCount>maxFiles){const error=new Error(parsed.received>limit?'That upload exceeds this form’s size limit.':'This form accepts fewer files.');error.status=413;res.status(413);return next(error);}return next();}
    const boundary = boundaryOf(type);
    if (!boundary) {
      res.status(400);
      const error = new Error('That upload could not be read.');
      error.status = 400;
      return next(error);
    }

    const declared = Number(req.get('content-length') || 0);
    if (declared && declared > limit) {
      res.status(413);
      const error = new Error('That upload is larger than this deployment can safely receive in one request.');
      error.status = 413;
      return next(error);
    }

    const chunks = [];
    let received = 0;
    let stopped = false;
    // Reserve through response completion: parsed files still retain their
    // source buffer after the request ends. Buffer.concat temporarily doubles
    // source memory, so this budget covers at most one default-size upload.
    let reserved=declared>0?declared:limit;
    if(reservedUploadBytes+reserved>memoryBudgetBytes){
      const error=new Error('Other files are being saved. Retry this upload shortly.');
      error.status=503;res.status(503);res.set?.('Retry-After','5');req.resume();return next(error);
    }
    reservedUploadBytes+=reserved;
    const release=()=>{reservedUploadBytes-=reserved;reserved=0;};
    res.once('finish',release);res.once('close',release);
    req.once('aborted',()=>{stopped=true;chunks.length=0;release();});

    req.on('data', (chunk) => {
      if (stopped) return;
      received += chunk.length;
      if (received > limit) {
        stopped = true;
        chunks.length=0;release();
        res.status(413);
        // Keep the connection alive long enough to deliver the useful 413.
        // Destroying the socket turned the owner's screen into a generic
        // network failure and also bypassed the filename-preserving UI.
        req.removeAllListeners('data');
        req.resume();
        const error = new Error('That upload is larger than this deployment can safely receive in one request.');
        error.status = 413;
        next(error);
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', (error) => {
      if (!stopped) { stopped = true; chunks.length=0;release();next(error); }
    });

    req.on('end', () => {
      if (stopped) return;
      stopped = true;
      try {
        const body=Buffer.concat(chunks);chunks.length=0;
        const { fields, files } = parseBody(body, boundary, { maxFiles });
        req.body = { ...(req.body || {}), ...fields };
        req.files = files;
        req.file = files[0] || null;req[parsedMultipart]={received,fileCount:files.length};
        next();
      } catch (error) {
        chunks.length=0;release();
        next(error);
      }
    });
  };
}

module.exports = { multipart, parseBody, boundaryOf, parseDisposition, DEFAULT_LIMIT, MAX_FILES };
