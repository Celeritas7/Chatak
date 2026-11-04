// chatak-public-config.js — what the published site connects to.
//
// The Supabase project URL and its anon key. Both are public by design: the
// key only identifies the project, and what anyone can read or write is
// decided by row-level security and the allow-list (authentication_mode_user_roles),
// so a visitor who is not on the list sees a sign-in and nothing else.
// vapidPublicKey is the PUBLIC half of the push key pair (docs/SETUP.md §8);
// its private half is the VAPID_PRIVATE_KEY secret in Supabase, never here.
// Never put the service_role key, or any other secret, in this file.
//
// js/chatak-config.js (gitignored, your own machine) still wins: anything
// filled in there overrides this, so a local setup is unchanged.
window.CHATAK_PUBLIC_CONFIG = {
  url: 'https://wylxvmkcrexwfpjpbhyy.supabase.co',
  anonKey: 'sb_publishable_e3pDOuxIdstaC7s0a680kQ_R10TrAyv',
  vapidPublicKey: 'BAyQqPQlE-v3Ri4nETSchZJEfEVgkizKt6GR_8aCxWWwmKy-CHpvx2nHDo5YE1BX1BC_GpMyONe4CfuuiyZZzSQ'
};
