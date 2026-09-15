'use strict';

/** Indexed candidate retrieval. Presentation and permission-safe destinations
 * remain in search-service; this module only narrows a large catalogue. */

function tokensOf(value) {
  return String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((token) => token.length >= 2).slice(0,8) || [];
}

function matchExpression(value) {
  return tokensOf(value).map((token) => `"${token.replaceAll('"','""')}"*`).join(' AND ');
}

function candidates(db, workspaceId, term, { limit = 150 } = {}) {
  const expression = matchExpression(term);
  if (!expression) return [];
  return db.prepare(`SELECT d.entity_type AS entityType,d.entity_id AS entityId,bm25(search_documents_fts) AS rank
    FROM search_documents_fts JOIN search_documents d ON d.rowid=search_documents_fts.rowid
    WHERE search_documents_fts MATCH ? AND d.workspace_id=?
    ORDER BY rank,d.entity_type,d.entity_id LIMIT ?`).all(expression,workspaceId,Math.min(500,Math.max(1,Number(limit) || 150)));
}

module.exports = { tokensOf, matchExpression, candidates };
