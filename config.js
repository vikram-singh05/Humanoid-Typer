// Project this panel talks to by default (baked in, so the panel needs no setup).
//
// The anon / publishable key is designed to be public: row level security in
// supabase/schema.sql is what keeps every account's tasks private. Never put the
// service_role key in this file — it bypasses RLS entirely.
window.AUTOTYPER_CONFIG = {
  supabaseUrl: 'https://foaiclcomklhgtudvegf.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZvYWljbGNvbWtsaGd0dWR2ZWdmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMxMTEwNDcsImV4cCI6MjEwODY4NzA0N30.hcAlVSOh3d8ymP-voMZ5kfULIVKMpwt6_KSxUqoH1bs',
};
