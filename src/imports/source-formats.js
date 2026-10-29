'use strict';

const accept='.csv,.tsv,.txt,.xlsx,.ods,.docx,.json,.pdf,.png,.jpg,.jpeg,.webp,.gif,.heic,.heif,.tif,.tiff';
const description='XLSX, ODS, Word tables, JSON, CSV, TSV, text, PDF and clear PNG, JPEG, WebP, static GIF, HEIC or TIFF images. Images: up to 20 MB, 10 pages and 12 megapixels in total. PDFs: up to 32 MB and 30 pages. XML and ZIP: export as CSV, JSON or XLSX. Verify extracted rows before approval.';
const groups=Object.freeze([{label:'Spreadsheets & text',formats:'Excel (.xlsx), OpenDocument (.ods), CSV, TSV and text tables'},{label:'Documents & records',formats:'PDF, Word tables (.docx) and JSON product records'},{label:'Images',formats:'PNG, JPEG, WebP, static GIF, HEIC, HEIF and TIFF'}]);
module.exports={accept,groups,get description(){return description+' Table capacity: '+require('./xlsx-reader').LIMITS.maxRows.toLocaleString('en-US')+' rows and '+require('./xlsx-reader').LIMITS.maxColumns+' columns. Larger sources need reviewed parts or a paginated connection; files are never silently truncated.';},get maxBytes(){return require('../config').uploads.maxBytes;}};
