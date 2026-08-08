# DesignExtract v3.1 — Vercel-ready real design extraction

DesignExtract analyzes a public website URL with a headless Chromium browser and returns a reusable design system for the UI:

- Real DOM element counts and semantic structure
- Computed colors and palette frequency
- Font families, sizes, weights and line-heights
- Spacing values and border-radius distribution
- Box shadows
- Navigation, headings, buttons, inputs, cards, links and footer samples
- CSS custom properties
- Stylesheet URLs and image/SVG metadata
- A bounded DOM snapshot for reconstruction/export

No screenshot is captured or stored.

## Vercel deployment

This project now uses a Vercel Node.js Function at:

```text
/api/extract
```

The frontend calls that endpoint on the same Vercel deployment, so no separate backend URL or CORS configuration is required for normal use.

### Project structure

```text
DesignExtract/
├── index.html
├── package.json
├── server.js
├── README.md
└── api/
    └── extract.js
```

The `api/extract.js` file is required because Vercel detects Node.js Functions from the `api` directory. Vercel's Node.js documentation specifies that a Node Function should be created inside `api` and export a default function.

### Deploy

1. Replace the files in your GitHub repository with this project structure.
2. Push/commit the changes.
3. Import or redeploy the repository in Vercel.
4. Keep the project as a normal Node.js project; no build command is required beyond the included `vercel-build` script.
5. After deployment, open:

```text
https://YOUR-DOMAIN.vercel.app/api/extract
```

You should receive a JSON health response. A successful response should contain `ok: true` and the DesignExtract service name.

6. Open the main website, sign in, go to **Website Extractor**, and test a public URL such as:

```text
https://example.com
```

### Important Vercel plan note

The extraction function is configured with `maxDuration = 120` seconds. Current Vercel limits vary by plan; Hobby supports up to 300 seconds, while longer limits are available on paid plans and Fluid Compute. If a target site is extremely slow or heavily protected, extraction can still fail or time out.

## Local development

Vercel production uses `@sparticuz/chromium` + `playwright-core` so Chromium can run inside the serverless environment.

For local development, the API expects a Chromium/Chrome executable path:

```bash
npm install
```

Then set an environment variable pointing to your local Chrome/Chromium executable:

```bash
CHROMIUM_EXECUTABLE_PATH="/path/to/chrome" npm start
```

Open:

```text
http://localhost:3000
```

On Windows PowerShell, for example:

```powershell
$env:CHROMIUM_EXECUTABLE_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
npm start
```

## API

### `GET /api/extract`

Health check.

### `POST /api/extract`

Request:

```json
{
  "url": "https://example.com"
}
```

Response:

```json
{
  "ok": true,
  "extraction": {
    "url": "https://example.com/",
    "hostname": "example.com"
  }
}
```

## Security

The API rejects:

- Non-HTTP/HTTPS URLs
- URLs containing embedded credentials
- localhost and `.local` targets
- Private IPv4/IPv6 addresses
- Hostnames that resolve to private network addresses
- Oversized request bodies

For a public production service, add authentication and rate limiting before allowing unrestricted traffic. The extraction endpoint intentionally remains public in this version so the existing frontend can call it without a user-specific backend account.

## Architecture

```text
Browser UI
   ↓
POST /api/extract
   ↓
Vercel Node.js Function
   ↓
Playwright Core + serverless Chromium
   ↓
Target public website
   ↓
DOM/CSS analysis
   ↓
Normalized design data
   ↓
Colors / Typography / Components / HTML / CSS
```

## Why the previous Vercel deployment stayed on loading

The previous project started a persistent Node HTTP server from `server.js`. That server created `/api/extract` only when `server.listen()` was running. A Vercel static deployment did not expose that root server as the `/api/extract` Function.

The new structure moves the actual extraction handler into `api/extract.js`, which is the Vercel Function entrypoint, while `server.js` remains only a small local-development server.
