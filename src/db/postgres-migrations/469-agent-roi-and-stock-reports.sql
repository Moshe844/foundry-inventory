-- Jobs 161, 162 and 163 keep their monthly reports in the shared report runs
-- and flags (457): the ROI report and its notice (161), the stock health check
-- and its worst items (162), and forecast accuracy, fill rate and on-time in
-- full (163).
ALTER TABLE stockchief_runtime.agent_report_runs DROP CONSTRAINT agent_report_runs_job_id_check;
ALTER TABLE stockchief_runtime.agent_report_runs ADD CONSTRAINT agent_report_runs_job_id_check CHECK (job_id IN (157,158,159,161,162,163));
ALTER TABLE stockchief_runtime.agent_report_flags DROP CONSTRAINT agent_report_flags_job_id_check;
ALTER TABLE stockchief_runtime.agent_report_flags ADD CONSTRAINT agent_report_flags_job_id_check CHECK (job_id IN (157,158,159,161,162,163));
