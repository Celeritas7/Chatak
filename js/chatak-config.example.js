// chatak-config.example.js — copy to js/chatak-config.js, then fill it in.
// run-chatak.bat does the copy for you the first time. The real file is
// gitignored and never shipped, so an upgrade cannot wipe your credentials.
//
// Paste your Supabase project URL and anon key below. The app reads this file
// at startup: with both values filled in it loads your real watchlist; with
// them blank it runs on generated sample data.
//
//   url     Supabase dashboard → Project Settings → API → Project URL
//   anonKey Supabase dashboard → Project Settings → API → anon / public key
//
// The anon key is designed to be public — row-level security is what protects
// the data, not the key. Never put the service_role key here.
//
// KEEP THIS FILE OUT OF GIT. The published GitHub Pages copy therefore has no
// credentials and runs on sample data, which is deliberate.

window.CHATAK_CONFIG = {
  url: '',
  anonKey: '',

  // How many days of history to pull per product for the graph and the median.
  historyDays: 365,

  // Normally leave this blank: sign-in returns you to the page you started
  // from, which is what you want on localhost and on the deployed site alike.
  // It is only honoured when it points at the origin you are already on, so it
  // can never bounce a local sign-in to the deployed build.
  //
  // Whatever you use, both origins must be listed in Supabase → Authentication
  // → URL Configuration → Redirect URLs:
  //   http://localhost:5080/**
  //   https://celeritas7.github.io/Chatak/**
  oauthRedirect: '',

  // What a visitor sees when url/anonKey above are blank. Leave unset to decide
  // by hostname (localhost → 'signin', anywhere else → 'sample'); set 'signin'
  // or 'sample' to force it.
  signedOutView: undefined,

  // Price matrix. One currency for every typed price until Cost's akatsuki_shops
  // carries a region column; then the grid splits per region.
  matrixCurrency: 'JPY',
  // A price asks to be re-checked after this many days, and is dimmed as stale after this many.
  matrixReviewDays: 40,
  matrixStaleDays: 45,

  // Where "Add shop in Cost" sends you. Cost owns shops; Chatak re-reads the
  // list when you come back to this tab.
  costShopsUrl: 'https://celeritas7.github.io/Cost_management/',

  // Phone notifications. The PUBLIC half of the VAPID key pair — the same value
  // as the VAPID_PUBLIC_KEY secret on the send-push function (docs/SETUP.md §8).
  // Public by design; the private half lives only in Supabase secrets.
  vapidPublicKey: ''
};
