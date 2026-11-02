// chatak-public-config.js — what the published site connects to.
//
// The Supabase project URL and its anon key. Both are public by design: the
// key only identifies the project, and what anyone can read or write is
// decided by row-level security and the allow-list (authentication_mode_user_roles),
// so a visitor who is not on the list sees a sign-in and nothing else.
// Never put the service_role key, or any other secret, in this file.
//
// js/chatak-config.js (gitignored, your own machine) still wins: anything
// filled in there overrides this, so a local setup is unchanged.
window.CHATAK_PUBLIC_CONFIG = {
  url: 'https://wylxvmkcrexwfpjpbhyy.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind5bHh2bWtjcmV4d2ZwanBiaHl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg2MzkxMDYsImV4cCI6MjA4NDIxNTEwNn0.6Bxo42hx4jwlJGWnfjiTpiDUsYfc1QLTN3YtrU1efak'
};
