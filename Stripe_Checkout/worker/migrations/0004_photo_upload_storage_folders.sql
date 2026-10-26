ALTER TABLE photo_upload_sessions
  ADD COLUMN storage_folder TEXT
  CHECK (
    storage_folder IS NULL OR (
      length(storage_folder) BETWEEN 17 AND 23 AND
      instr(storage_folder, '/') = 0
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS photo_upload_sessions_storage_folder_idx
  ON photo_upload_sessions(storage_folder)
  WHERE storage_folder IS NOT NULL;
