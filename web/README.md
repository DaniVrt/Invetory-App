# Υλικό Inventory - Web App

A rebuild of the inventory app as a plain web app (HTML/CSS/JS) talking directly
to Supabase - no server of your own to run or host.

## Files

- `index.html` - page structure
- `style.css` - dark theme styling
- `app.js` - all the logic (auth, warehouses, categories, products, admin)
- `config.js` - your Supabase project URL + publishable key

## How it works

- Sign up / log in with email + password (handled by Supabase Auth - no
  passwords stored in your own tables).
- Each account can belong to multiple **warehouses** (`sistimata`). Creating
  a warehouse automatically makes you its admin.
- Only an admin can add other people to a warehouse, by their email (they
  must have already signed up once, so their account exists).
- Anyone in a warehouse (admin or member) can add, view, adjust quantity on,
  or delete inventory items, and create new categories on the fly.
- Items with an expiration date (e.g. pharmacy stock) are flagged as
  "EXPIRED" once the date has passed, and can be filtered to show only
  expired items.

## Running it locally

Because the page uses JS modules, opening `index.html` directly by
double-clicking it won't work reliably in every browser (module scripts are
picky about the `file://` protocol). Serve it with a tiny local server
instead, from this folder:

```
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

## Deploying for free

Since Supabase is the backend, you don't need to host a server - just these
static files. Easiest options:

1. **Netlify** (drag-and-drop): go to app.netlify.com, drag this folder onto
   the deploy area, done. You get a URL like `yourapp.netlify.app`.
2. **GitHub Pages**: push this folder to a GitHub repo, enable Pages in the
   repo settings, pointing at the branch/folder.

Either way, no ongoing cost, no server to keep running.

## A note on email confirmation

By default, Supabase requires a new user to click a confirmation link in
their email before they can log in. If you want testers to be able to sign
up and use the app immediately (no email confirmation step), you can turn
that off in your Supabase project: **Authentication -> Providers -> Email ->
Confirm email** (toggle off). For a real deployment where you care about
verifying real email addresses, you'd want to leave it on.

## Extending it

Some natural next steps if you want to keep building:
- A "join by code" flow instead of admin-adds-by-email, if you want people
  to self-serve into a warehouse.
- Push notifications / email digest for items nearing expiration.
- CSV export of current inventory.
