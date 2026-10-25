ALTER TABLE workspaces ADD COLUMN answer_style text;
ALTER TABLE workspaces ADD CONSTRAINT workspace_answer_style_length CHECK (length(answer_style)<=500);
