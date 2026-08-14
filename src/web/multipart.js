'use strict';

/**
 * Reading an uploaded file off the request.
 *
 * Express parses forms and JSON but not file uploads, and the usual answer is a
 * dependency. This is the whole of what Foundry needs from one: split the body
 * on its boundary, keep the fields as fields and the files as buffers, and stop
 * at a size limit. Binary-safe throughout — the parts are sliced as Buffers and
 * never turned into strings, because an .xlsx is a zip and would not survive it.
 *
 * The ordinary fields land in `req.body` exactly as a normal form would, which
 * matters: CSRF checking is the same code path for an upload as for a button.
 */

const DEFAULT_LIMIT = 32 * 1024 * 1024;
const MAX_PARTS = 40;
const MAX_FILES = 4;

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
    // Only the basename: a filename is display text, never a path Foundry follows.
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

function parseBody(body, boundary) {
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
      if (files.length >= MAX_FILES || filename === '') continue;
      files.push({ field: name, filename, size: content.length, buffer: content });
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
function multipart({ limit = DEFAULT_LIMIT } = {}) {
  return function multipartMiddleware(req, res, next) {
    const type = req.get('content-type') || '';
    if (!type.toLowerCase().startsWith('multipart/form-data')) return next();

    const boundary = boundaryOf(type);
    if (!boundary) {
      res.status(400);
      return next(new Error('That upload could not be read.'));
    }

    const declared = Number(req.get('content-length') || 0);
    if (declared && declared > limit) {
      res.status(413);
      return next(new Error('That file is larger than Foundry can read.'));
    }

    const chunks = [];
    let received = 0;
    let stopped = false;

    req.on('data', (chunk) => {
      if (stopped) return;
      received += chunk.length;
      if (received > limit) {
        stopped = true;
        res.status(413);
        req.destroy();
        next(new Error('That file is larger than Foundry can read.'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', (error) => {
      if (!stopped) { stopped = true; next(error); }
    });

    req.on('end', () => {
      if (stopped) return;
      stopped = true;
      try {
        const { fields, files } = parseBody(Buffer.concat(chunks), boundary);
        req.body = { ...(req.body || {}), ...fields };
        req.files = files;
        req.file = files[0] || null;
        next();
      } catch (error) {
        next(error);
      }
    });
  };
}

module.exports = { multipart, parseBody, boundaryOf, parseDisposition, DEFAULT_LIMIT, MAX_FILES };
