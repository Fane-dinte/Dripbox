<p align="center"><img src="docs/banner.svg" alt="Dripbox" width="100%"></p>

<p align="center">
  <img alt="Cloudflare Pages" src="https://img.shields.io/badge/Cloudflare-Pages-F38020?logo=cloudflare&logoColor=white">
  <img alt="R2" src="https://img.shields.io/badge/storage-R2-4d8dff">
  <img alt="PWA" src="https://img.shields.io/badge/PWA-instalabil-5A0FC8">
  <img alt="Licență MIT" src="https://img.shields.io/badge/licen%C8%9B%C4%83-MIT-green">
</p>

**Dripbox** e un „AirDrop privat” pe internet: trimiți text, linkuri, poze și fișiere între telefon, laptop și PC, și le dai și prietenilor tăi parola. Totul stă într-un singur Cloudflare Worker și într-un bucket R2 din **contul tău**, fără server, fără bază de date și fără abonament.

## Ce poate

- **Text, linkuri și fișiere de orice mărime.** Peste 95 MB se trimite pe bucăți de 50 MB, 3 în paralel (testat cu 5,5 GB).
- **Compozitor ca în WhatsApp.** Atașezi din Galerie, Cameră sau Document, vezi miniaturile înainte să trimiți și poți adăuga o descriere. Pe PC: `Ctrl+V` și drag & drop, `Enter` trimite.
- **Share direct din telefon.** Instalat din Chrome pe Android, apare în meniul „Distribuie”.
- **Copiere cu un tap** pentru text, linkuri și imagini (convertite în PNG pentru clipboard).
- **Link public pe fișier**, valabil 7 zile, semnat. Video-urile se pot derula, iar HTML/SVG se servesc izolat (CSP sandbox).
- **Proprietar și invitați.** Cu `ADMIN_PASS` vezi toate dispozitivele conectate (nume, browser, oraș, ultima activitate), le scoți pe unele sau pe toate și schimbi parola pentru ceilalți.
- **Teme** (clasic și negru, cu 6 accente), instalare ca aplicație, actualizare automată la versiune nouă.
- **Șterge singur** ce e mai vechi de 30 de zile, dacă nu fixezi elementul.

## Costuri sub control

| Protecție | Cum |
|---|---|
| Spațiu | Refuză peste `LIMIT_GB` (implicit 9 GB, sub cei 10 GB gratuiți din R2), rezervările multipart incluse |
| Scrieri | Contor propriu, refuz peste 600.000 pe lună (R2 dă 1 milion gratis) |
| Citiri | Limitate de planul Free Workers (100.000 cereri/zi), oprire dură, fără factură |
| Polling | 4 s cât ești activ, 30 s după 5 minute, deloc cu tab-ul ascuns; lista folosește ETag (304 ieftin) |

## Instalare pe contul tău

Ai nevoie de un cont Cloudflare (gratuit). R2 cere un card în cont, dar nu se taxează nimic în limita gratuită. Nu e nevoie să instalezi nimic local.

### Varianta 1: din browser

1. **Descarcă repo-ul** (`Code → Download ZIP`) și dezarhivează-l. Nu ai nevoie de `README.md` și `docs/`, dar nu strică.
2. **Creează bucket-ul:** Cloudflare → **R2 Object Storage → Create bucket**, nume `dripbox`, rămâne privat.
3. **Creează proiectul:** **Workers & Pages → Create → Pages → Upload assets**, nume `dripbox`, trage în pagină *conținutul* folderului (cu `_worker.js` la rădăcină, nu într-un subfolder) și apasă **Deploy**.
4. **Leagă bucket-ul:** proiectul → **Settings → Bindings → Add → R2 bucket**, nume variabilă **`BUCKET`**, bucket `dripbox`.
5. **Pune parolele:** **Settings → Variables and Secrets → Add** (tip *Secret*):
   - `PASS`: parola pe care o dai prietenilor.
   - `ADMIN_PASS`: parola ta de proprietar (alta decât `PASS`).
   - opțional, ca variabile: `TTL_DAYS` (implicit `30`, `0` = nu șterge niciodată) și `LIMIT_GB` (implicit `9`, maxim `9.5`).
6. **Redeploy:** **Deployments → Create deployment**, încarcă din nou folderul. Binding-urile și secretele se aplică doar la următorul deploy.
7. Deschide `https://dripbox.pages.dev` (sau numele ales), intră cu `ADMIN_PASS` și instalează-l din meniul browserului.

### Varianta 2: din terminal

```bash
npm i -g wrangler
wrangler login
wrangler r2 bucket create dripbox
wrangler pages project create dripbox --production-branch main
wrangler pages deploy . --project-name dripbox
wrangler pages secret put PASS --project-name dripbox
wrangler pages secret put ADMIN_PASS --project-name dripbox
```

Apoi leagă bucket-ul la Pages (pasul 4 de mai sus, în dashboard: **Settings → Bindings → R2 bucket**, `BUCKET` → `dripbox`) și rulează din nou `wrangler pages deploy . --project-name dripbox`.

### Rulat local

```bash
npx wrangler pages dev . --r2 BUCKET --binding PASS=test123 ADMIN_PASS=owner-pass-1 --port 8788
```

Deschide `http://localhost:8788`. Fișierele stau într-un R2 simulat pe disc.

## Cum e făcut

- `_worker.js`: tot API-ul (Cloudflare Pages, *advanced mode*). Restul sunt fișiere statice: `index.html` (toată aplicația), `sw.js`, `manifest.webmanifest`, iconițe.
- În R2: `_index.json` (lista elementelor, contorul de scrieri și rezervările multipart, actualizat cu compare-and-swap pe etag), `_sessions.json` (sesiunile de login), `_auth.json` (parola pentru invitați, setată din aplicație, salvată cu sare + SHA-256) și `f/<id>` (fișierele).
- Cookie de sesiune `HttpOnly`, semnat HMAC, valabil 400 de zile, valid doar cât sesiunea există în `_sessions.json`.
- La fiecare versiune nouă crești `const V = "dripbox-N"` din `sw.js`, ca telefoanele să ia aplicația nouă.

## Limite cunoscute

- iPhone: fără „Distribuie → Dripbox” (Safari nu suportă Web Share Target). Firefox desktop nu instalează PWA.
- Share din telefon merge doar când e instalat din **Chrome**, nu din Brave.
- Browserul integrat din unele aplicații blochează clipboard-ul; testează în Chrome sau Edge.

## Licență

[MIT](LICENSE). Folosește-l, schimbă-l, instalează-l pe contul tău. Datele tale rămân în R2-ul tău.
