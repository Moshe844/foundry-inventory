-- Reports read recorded label charges from this table. Without these triggers a
-- cached report kept showing the earlier charge after a provider's amount was
-- recorded, because nothing told the read model the row had changed.
CREATE TRIGGER read_model_insert AFTER INSERT ON shipping_label_transactions REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
CREATE TRIGGER read_model_update AFTER UPDATE ON shipping_label_transactions REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
CREATE TRIGGER read_model_delete AFTER DELETE ON shipping_label_transactions REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
