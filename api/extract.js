import dns from 'node:dns/promises';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { chromium as playwrightChromium } from 'playwright-core';
import sparticuzChromium from '@sparticuz/chromium';

export const maxDuration = 120;

const MAX_TIMEOUT = Math.min(Number(process.env.EXTRACTION_TIMEOUT || 45000), 90000);
const MAX_BODY_BYTES = 1024 * 1024;

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  if (typeof res.status === 'function') {
    Object.entries(headers).forEach(([k, v]) => res.setHeader?.(k, v));
    return res.status(status).json(data);
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(body);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
    'Cache-Control': 'no-store',
  };
}

function normalizeUrl(input) {
  const value = String(input || '').trim();
  if (!value) throw new Error('URL is required');

  const href = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(href);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP/HTTPS URLs are supported');
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not supported');
  }

  return url;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0
    );
  }

  const s = ip.toLowerCase();
  return (
    s === '::1' ||
    s === '::' ||
    s.startsWith('fc') ||
    s.startsWith('fd') ||
    s.startsWith('fe80:')
  );
}

async function assertPublicHost(url) {
  const host = url.hostname.toLowerCase();

  if (
    host === 'localhost' ||
    host === 'localhost.localdomain' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    throw new Error('Local/private hosts are not allowed');
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Private network addresses are not allowed');
    return;
  }

  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error('The target host resolves to a private network');
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;

  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large');
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON');
  }
}

async function launchBrowser() {
  const isVercel = Boolean(process.env.VERCEL);

  if (isVercel) {
    sparticuzChromium.setGraphicsMode = false;
    return playwrightChromium.launch({
      args: [
        ...sparticuzChromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--user-data-dir=/tmp/dx-${randomUUID()}`,
      ],
      executablePath: await sparticuzChromium.executablePath(),
      headless: true,
    });
  }

  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || process.env.GOOGLE_CHROME_BIN;
  if (!executablePath) {
    throw new Error(
      'Local Chromium executable not configured. Set CHROMIUM_EXECUTABLE_PATH, or deploy to Vercel.'
    );
  }

  return playwrightChromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}

async function extractDesign(target) {
  const browser = await launchBrowser();

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      locale: 'en-US',
      userAgent: 'DesignExtract/3.1 (+design-analysis)',
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();
    page.setDefaultTimeout(MAX_TIMEOUT);

    await page.goto(target.href, {
      waitUntil: 'domcontentloaded',
      timeout: MAX_TIMEOUT,
    });

    await page.waitForLoadState('networkidle', {
      timeout: Math.min(MAX_TIMEOUT, 12000),
    }).catch(() => {});

    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready.catch(() => {});
      window.scrollTo(0, 0);
    });

    return await page.evaluate(() => {
      const clean = (v, max = 500) =>
        String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
      const uniq = (a) => [...new Set(a.filter(Boolean))];
      const css = (el) => getComputedStyle(el);
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = css(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const color = (value) => {
        const s = String(value || '').trim();
        if (!s || s === 'transparent') return null;
        const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (m) return '#' + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
        return /^#[0-9a-f]{3,8}$/i.test(s) ? s.toUpperCase() : s;
      };
      const num = (v) => {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : null;
      };

      const elements = [...document.querySelectorAll('body *')].filter(visible).slice(0, 5000);
      const count = (sel) => document.querySelectorAll(sel).length;

      const colorMap = new Map();
      const addColor = (value, role) => {
        const c = color(value);
        if (!c) return;
        const k = `${c}|${role}`;
        colorMap.set(k, (colorMap.get(k) || 0) + 1);
      };
      elements.forEach((el) => {
        const s = css(el);
        addColor(s.color, 'text');
        addColor(s.backgroundColor, 'background');
        addColor(s.borderTopColor, 'border');
        addColor(s.boxShadow.match(/rgba?\([^)]*\)/)?.[0], 'shadow');
      });
      const palette = [...colorMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 24)
        .map(([key, count]) => {
          const [hex, kind] = key.split('|');
          return { name: kind[0].toUpperCase() + kind.slice(1), hex, kind, count };
        });

      const fontStats = new Map();
      const sizeStats = new Map();
      const weightStats = new Map();
      const lineStats = new Map();
      const add = (map, k) => {
        if (k) map.set(k, (map.get(k) || 0) + 1);
      };
      elements.forEach((el) => {
        const s = css(el);
        add(fontStats, clean(s.fontFamily, 180));
        add(sizeStats, s.fontSize);
        add(weightStats, s.fontWeight);
        add(lineStats, s.lineHeight);
      });
      const top = (map) =>
        [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([value, count]) => ({ value, count }));
      const fontsTop = top(fontStats);
      const fontFamilies = fontsTop.map((x) => x.value);

      const spacingMap = new Map();
      elements.forEach((el) => {
        const s = css(el);
        [
          s.marginTop, s.marginRight, s.marginBottom, s.marginLeft,
          s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft,
          s.gap, s.rowGap, s.columnGap,
        ].forEach((v) => {
          const n = num(v);
          if (n > 0 && n <= 240) {
            const k = Math.round(n);
            spacingMap.set(k, (spacingMap.get(k) || 0) + 1);
          }
        });
      });
      const spacing = [...spacingMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 24)
        .sort((a, b) => a[0] - b[0])
        .map((x) => x[0]);

      const radiusMap = new Map();
      elements.forEach((el) => {
        const n = num(css(el).borderTopLeftRadius);
        if (n > 0) {
          const k = Math.round(n);
          radiusMap.set(k, (radiusMap.get(k) || 0) + 1);
        }
      });
      const radii = [...radiusMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([value, count]) => ({ value, count }));
      const radius = radii[0]?.value ?? 8;

      const shadowMap = new Map();
      elements.forEach((el) => {
        const v = clean(css(el).boxShadow, 300);
        if (v && v !== 'none') add(shadowMap, v);
      });
      const shadows = top(shadowMap).slice(0, 10);

      const selectorLabel = (el) => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join('');
        return `${tag}${id}${cls}`.slice(0, 180);
      };
      const sample = (selector, limit = 12) =>
        [...document.querySelectorAll(selector)].filter(visible).slice(0, limit).map((el) => {
          const s = css(el);
          const r = el.getBoundingClientRect();
          return {
            selector: selectorLabel(el),
            text: clean(el.textContent, 180),
            width: Math.round(r.width),
            height: Math.round(r.height),
            display: s.display,
            position: s.position,
            fontFamily: clean(s.fontFamily, 120),
            fontSize: s.fontSize,
            fontWeight: s.fontWeight,
            lineHeight: s.lineHeight,
            color: color(s.color),
            background: color(s.backgroundColor),
            borderRadius: s.borderRadius,
            border: s.border,
            padding: s.padding,
            margin: s.margin,
            gap: s.gap,
            boxShadow: s.boxShadow === 'none' ? null : clean(s.boxShadow, 250),
          };
        });

      const components = [
        { type: 'Navigation', count: count('nav, header'), samples: sample('nav, header', 6) },
        { type: 'Headings', count: count('h1,h2,h3,h4,h5,h6'), samples: sample('h1,h2,h3,h4,h5,h6', 10) },
        { type: 'Buttons', count: count('button, [role="button"], a.btn, a[class*="button"], a[class*="Button"]'), samples: sample('button, [role="button"], a.btn, a[class*="button"], a[class*="Button"]', 12) },
        { type: 'Inputs', count: count('input, textarea, select'), samples: sample('input, textarea, select', 10) },
        { type: 'Cards', count: count('article, [class*="card"], [class*="Card"]'), samples: sample('article, [class*="card"], [class*="Card"]', 12) },
        { type: 'Links', count: count('a'), samples: sample('a', 10) },
        { type: 'Footer', count: count('footer'), samples: sample('footer', 3) },
      ].filter((x) => x.count);

      const cssVariables = {};
      for (const sheet of [...document.styleSheets]) {
        try {
          for (const rule of [...sheet.cssRules]) {
            if (rule.style) {
              for (const name of rule.style) {
                if (name.startsWith('--')) cssVariables[name] = rule.style.getPropertyValue(name).trim();
              }
            }
          }
        } catch (_) {}
      }

      const stylesheets = uniq([...document.querySelectorAll('link[rel="stylesheet"]')].map((x) => x.href));
      const images = uniq([...document.images].map((x) => x.currentSrc || x.src)).slice(0, 100);
      const svg = [...document.querySelectorAll('svg')].slice(0, 30).map((el) => ({
        viewBox: el.getAttribute('viewBox'),
        width: css(el).width,
        height: css(el).height,
        aria: el.getAttribute('aria-label'),
      }));
      const body = css(document.body);
      const pageLayout = {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        bodyDisplay: body.display,
        bodyFont: clean(body.fontFamily, 160),
        bodyColor: color(body.color),
        bodyBackground: color(body.backgroundColor),
        bodyMargin: body.margin,
      };
      const semantic = {
        sections: count('main section, body > section, main > div'),
        navs: count('nav'),
        headers: count('header'),
        footers: count('footer'),
        forms: count('form'),
        lists: count('ul,ol'),
        tables: count('table'),
      };

      const visualProps = [
        'display','position','top','right','bottom','left','zIndex','boxSizing',
        'width','minWidth','maxWidth','height','minHeight','maxHeight',
        'marginTop','marginRight','marginBottom','marginLeft',
        'paddingTop','paddingRight','paddingBottom','paddingLeft',
        'fontFamily','fontSize','fontWeight','fontStyle','fontStretch','lineHeight','letterSpacing','textTransform','textDecoration','textAlign','whiteSpace','wordBreak','textOverflow',
        'color','backgroundColor','backgroundImage','backgroundSize','backgroundPosition','backgroundRepeat','backgroundAttachment',
        'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','borderTopStyle','borderRightStyle','borderBottomStyle','borderLeftStyle',
        'borderTopColor','borderRightColor','borderBottomColor','borderLeftColor','borderTopLeftRadius','borderTopRightRadius','borderBottomRightRadius','borderBottomLeftRadius',
        'boxShadow','opacity','overflow','overflowX','overflowY','visibility',
        'flexDirection','flexWrap','flexGrow','flexShrink','flexBasis','alignItems','alignContent','alignSelf','justifyContent','justifyItems','justifySelf','gap','rowGap','columnGap',
        'gridTemplateColumns','gridTemplateRows','gridColumnGap','gridRowGap','gridAutoColumns','gridAutoRows','gridAutoFlow',
        'objectFit','objectPosition','aspectRatio','cursor','transform','transformOrigin','filter','backdropFilter',
      ];
      const cssValue = (v) => String(v ?? '').replace(/[<>]/g, '');
      const inlineVisualStyles = (el) => {
        const st = css(el);
        return visualProps.map((prop) => `${prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${cssValue(st[prop])}`).join(';');
      };
      const pseudoStyle = (el, pseudo) => {
        try {
          const st = getComputedStyle(el, pseudo);
          if (!st || st.content === 'none' || st.content === 'normal') return '';
          const props = ['content','display','position','top','right','bottom','left','width','height','color','backgroundColor','backgroundImage','border','borderRadius','boxShadow','opacity','zIndex','fontFamily','fontSize','fontWeight','lineHeight','transform','margin','padding'];
          return props.map((prop) => `${prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${cssValue(st[prop])}`).join(';');
        } catch (_) {
          return '';
        }
      };

      const buildReconstruction = () => {
        const root = document.body.cloneNode(true);
        root.querySelectorAll('script,style,noscript,template,iframe,object,embed').forEach((n) => n.remove());
        const maxNodes = 2200;
        let clones = [root, ...root.querySelectorAll('*')];
        if (clones.length > maxNodes) {
          for (let i = clones.length - 1; i >= maxNodes; i--) clones[i].remove();
          clones = [root, ...root.querySelectorAll('*')];
        }
        const originals = [document.body, ...document.body.querySelectorAll('*')].slice(0, clones.length);
        const pseudoRules = [];

        clones.forEach((clone, i) => {
          const original = originals[i];
          if (!original) return;
          clone.removeAttribute('style');
          clone.setAttribute('style', inlineVisualStyles(original));
          clone.setAttribute('data-dx-node', String(i));
          ['href','src','poster'].forEach((attr) => {
            if (clone.hasAttribute(attr)) {
              try { clone.setAttribute(attr, new URL(clone.getAttribute(attr), location.href).href); } catch (_) {}
            }
          });
          if (clone.tagName === 'A') clone.setAttribute('href', '#');
          if (clone.tagName === 'FORM') clone.setAttribute('action', '#');
          if (['INPUT','TEXTAREA','SELECT','BUTTON'].includes(clone.tagName)) clone.setAttribute('data-design-extract-control', 'true');

          const before = pseudoStyle(original, '::before');
          const after = pseudoStyle(original, '::after');
          if (before) pseudoRules.push(`[data-dx-node="${i}"]::before{${before}}`);
          if (after) pseudoRules.push(`[data-dx-node="${i}"]::after{${after}}`);
        });

        const lang = (document.documentElement.lang || 'en').replace(/[^a-zA-Z-]/g, '');
        const title = clean(document.title, 200).replace(/[<>]/g, '');
        const baseCss = `html,body{margin:0}img,svg,video{max-width:100%}button,input,textarea,select{font:inherit}${pseudoRules.join('')}`;
        return '<!doctype html>\n<html lang="' + lang + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="' + location.origin + '"><title>' + title + '</title><style id="designextract-reconstruction">' + baseCss + '</style></head>' + root.outerHTML + '</html>';
      };

      const reconstructedHtml = buildReconstruction();
      const htmlSnapshot = clean(document.body.innerHTML, 120000);

      return {
        url: location.href,
        hostname: location.hostname,
        title: clean(document.title || document.querySelector('h1')?.textContent || location.hostname, 200),
        palette,
        fonts: {
          display: fontsTop[0]?.value || 'sans-serif',
          body: fontsTop[0]?.value || 'sans-serif',
          families: fontFamilies,
          sizes: top(sizeStats),
          weights: top(weightStats),
          lineHeights: top(lineStats),
        },
        radius,
        radii,
        spacing,
        shadows,
        components,
        layout: pageLayout,
        semantic,
        assets: { stylesheets: stylesheets.slice(0, 50), images, svgCount: count('svg'), svgSamples: svg },
        cssVariables: Object.fromEntries(Object.entries(cssVariables).slice(0, 200)),
        metrics: {
          elementsAnalyzed: elements.length,
          totalDomElements: document.querySelectorAll('*').length,
          buttons: count('button, [role="button"]'),
          inputs: count('input, textarea, select'),
          forms: count('form'),
          images: count('img'),
          headings: count('h1,h2,h3,h4,h5,h6'),
          links: count('a'),
        },
        htmlSnapshot,
        reconstructedHtml,
        reconstruction: { mode: 'computed-dom', nodesLimit: 2200, screenshot: false },
        extractedAt: new Date().toISOString(),
      };
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

export default async function handler(req, res) {
  const headers = corsHeaders();
  Object.entries(headers).forEach(([key, value]) => res.setHeader?.(key, value));

  if (req.method === 'OPTIONS') {
    if (typeof res.status === 'function') return res.status(204).end();
    res.writeHead(204, headers);
    return res.end();
  }

  if (req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      service: 'DesignExtract extractor v3.1',
      screenshot: false,
      runtime: process.env.VERCEL ? 'vercel' : 'node',
    }, headers);
  }

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' }, headers);
  }

  try {
    const body = await readBody(req);
    const target = normalizeUrl(body.url);
    await assertPublicHost(target);

    const extraction = await extractDesign(target);
    return json(res, 200, { ok: true, extraction }, headers);
  } catch (error) {
    console.error('DesignExtract extraction error:', error);
    const message = error?.message || 'Extraction failed';
    const status = /required|supported|private|credentials|too large|invalid json/i.test(message) ? 400 : 500;
    return json(res, status, { error: message }, headers);
  }
}
