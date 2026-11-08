ALTER TABLE suppliers
  ADD COLUMN free_freight_threshold_minor bigint,
  ADD COLUMN ordinary_freight_minor bigint,
  ADD COLUMN freight_terms_currency text,
  ADD CHECK ((free_freight_threshold_minor IS NULL AND ordinary_freight_minor IS NULL AND freight_terms_currency IS NULL)
    OR (free_freight_threshold_minor IS NOT NULL AND free_freight_threshold_minor>0 AND ordinary_freight_minor IS NOT NULL
        AND ordinary_freight_minor>=0 AND freight_terms_currency IS NOT NULL));
