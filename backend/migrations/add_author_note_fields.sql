ALTER TABLE user_settings ADD COLUMN author_note TEXT;
ALTER TABLE user_settings ADD COLUMN author_note_position VARCHAR DEFAULT 'after_char';
ALTER TABLE user_settings ADD COLUMN author_note_frequency INTEGER DEFAULT 0;
