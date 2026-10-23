# Newspaper Delivery

A small web app for newspaper delivery. It runs in Safari and can be added to the iPhone home screen.

- **Direction**: map + current house, Done / Skip / Undo, swipeable "Up next" cards.
- **Overview**: whole area, progress, papers needed today.
- **Settings**: areas, houses (add / edit / reorder / hold), backup.

All house data is stored only on the phone (no server). Use **Settings → Export backup** regularly.

## Files
`index.html`, `app.js`, `sw.js` (offline), `manifest.webmanifest`, `icon-*.png`.

## Hosting (GitHub Pages)
1. Create a repository, upload these files to it.
2. Settings → Pages → Branch: `main`, folder `/ (root)` → Save.
3. Open `https://<username>.github.io/<repo>/` on the iPhone in Safari → Share → Add to Home Screen.

Only the app code is public. Customer names stay on your phone and are never uploaded.
