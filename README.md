<p align="center"><img src="docs/banner.svg" alt="Dripbox" width="100%"></p>

<p align="center">
  <img alt="Cloudflare Pages" src="https://img.shields.io/badge/Cloudflare-Pages-F38020?logo=cloudflare&logoColor=white">
  <img alt="R2" src="https://img.shields.io/badge/storage-R2-4d8dff">
  <img alt="PWA" src="https://img.shields.io/badge/PWA-installable-5A0FC8">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green">
</p>

**Dripbox** is a private "AirDrop" over the internet. Send text, links, photos and files between your phone, laptop and PC, and share the password with friends. It all runs in one Cloudflare Worker plus an R2 bucket in **your own account**: no server, no database, no subscription.

## What it does

- **Text, links and files of any size.** Anything over 95 MB is uploaded in 50 MB chunks, 3 in parallel (tested with 5.5 GB).
- **A WhatsApp-style composer.** Attach from the gallery, camera or documents, preview thumbnails before sending, and add a caption. On a PC: `Ctrl+V` and drag & drop; `Enter` sends.
- **Share straight from your phone.** Installed from Chrome on Android, it shows up in the Share menu.
- **One-tap copy** for text, links and images (images are converted to PNG for the clipboard).
- **Public links per file**, valid for 7 days and signed. Videos can be scrubbed, and HTML/SVG is served sandboxed (CSP).
- **Owner and guests.** With `ADMIN_PASS` you see every signed-in device (name, browser, city, last activity), sign out one or all of them, and change the guests' password.
- **Themes** (classic and black, with 6 accents), installable as an app, and it reloads itself when a new version ships.
- **Cleans up after itself:** items older than 30 days are deleted unless you pin them.

## Costs stay under control

| Safeguard | How |
|---|---|
| Storage | Refuses new uploads above `LIMIT_GB` (default 9 GB, below R2's 10 GB free tier), pending multipart uploads included |
| Writes | Own counter; refuses above 600,000 a month (R2 gives 1 million free) |
| Reads | Capped by the Workers Free plan (100,000 requests/day), a hard stop with no bill |
| Polling | 4 s while you're active, 30 s after 5 idle minutes, none with the tab hidden; the list uses ETags (cheap 304s) |

## Set it up on your own account

You need a Cloudflare account (free). R2 asks for a card on file, but nothing is charged inside the free tier. You don't have to install anything locally.

### Option 1: in the browser

1. **Get the files:** Code → Download ZIP, then unzip. (`README.md` and `docs/` are not needed, but they do no harm.)
2. **Create the bucket:** Cloudflare → **R2 Object Storage → Create bucket**, named `dripbox`, left private.
3. **Create the project:** **Workers & Pages → Create → Pages → Upload assets**, name it `dripbox`, drag in the *contents* of the folder (with `_worker.js` at the root, not inside a subfolder) and press **Deploy**.
4. **Bind the bucket:** project → **Settings → Bindings → Add → R2 bucket**, variable name **`BUCKET`**, bucket `dripbox`.
5. **Set the passwords:** **Settings → Variables and Secrets → Add** (type *Secret*):
   - `PASS`: the password you give to friends.
   - `ADMIN_PASS`: your owner password (different from `PASS`).
   - optionally, as variables: `TTL_DAYS` (default `30`, `0` = never delete) and `LIMIT_GB` (default `9`, max `9.5`).
6. **Redeploy:** **Deployments → Create deployment** and upload the folder again. Bindings and secrets only apply on the next deploy.
7. Open `https://dripbox.pages.dev` (or the name you chose), sign in with `ADMIN_PASS` and install it from the browser menu.

### Option 2: from a terminal

```bash
npm i -g wrangler
wrangler login
wrangler r2 bucket create dripbox
wrangler pages project create dripbox --production-branch main
wrangler pages deploy . --project-name dripbox
wrangler pages secret put PASS --project-name dripbox
wrangler pages secret put ADMIN_PASS --project-name dripbox
```

Then bind the bucket in the dashboard (step 4 above: **Settings → Bindings → R2 bucket**, `BUCKET` → `dripbox`) and run `wrangler pages deploy . --project-name dripbox` once more.

### Run it locally

```bash
npx wrangler pages dev . --r2 BUCKET --binding PASS=test123 ADMIN_PASS=owner-pass-1 --port 8788
```

Open `http://localhost:8788`. Files are kept in a simulated R2 on disk.

## How it's built

- `_worker.js` is the whole API (Cloudflare Pages, *advanced mode*). Everything else is static: `index.html` (the entire app), `sw.js`, `manifest.webmanifest` and icons.
- In R2: `_index.json` (the item list, the write counter and pending multipart reservations, updated with compare-and-swap on the etag), `_sessions.json` (login sessions), `_auth.json` (the guests' password, set from the app and stored salted + SHA-256) and `f/<id>` (the files).
- An `HttpOnly`, HMAC-signed session cookie valid for 400 days, accepted only while the session exists in `_sessions.json`.
- With every new version, bump `const V = "dripbox-N"` in `sw.js` so phones pick it up.

## Known limits

- iPhone: no Share → Dripbox (Safari doesn't support Web Share Target). Firefox on desktop can't install PWAs.
- Sharing from the phone works only when installed from **Chrome**, not Brave.
- Some in-app browsers block the clipboard; test in Chrome or Edge.

## License

[MIT](LICENSE). Use it, change it, run it on your own account. Your data stays in your own R2 bucket.
