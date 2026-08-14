'use strict';

const express = require('express');
const searchService = require('../../domain/search-service');
const { requireAuth, asyncRoute } = require('../middleware');

const router = express.Router();

router.get(
  '/search',
  requireAuth,
  asyncRoute(async (req, res) => {
    const term = String(req.query.q || '').trim();
    const result = term ? searchService.search(req.db, req.ctx.workspaceId, term, { limit: 25 }) : { results: [], term };
    res.page('search', {
      title: term ? `Search · ${term}` : 'Search',
      nav: 'inventory',
      searchTerm: term,
      results: result.results,
    });
  })
);

/** Backs the type-ahead in the top bar. */
router.get(
  '/api/search',
  requireAuth,
  asyncRoute(async (req, res) => {
    const term = String(req.query.q || '').trim();
    if (term.length < 2) return res.json({ results: [] });
    const result = searchService.search(req.db, req.ctx.workspaceId, term, { limit: 5 });
    return res.json({
      results: result.results.slice(0, 12).map((r) => ({
        type: r.type,
        title: r.title,
        subtitle: r.subtitle,
        meta: r.meta,
        href: r.href,
      })),
    });
  })
);

module.exports = router;
