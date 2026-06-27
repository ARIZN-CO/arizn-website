'use strict';
// Vercel Serverless Function — GET /api/reject?token=XXX
// Required Vercel env vars: APPROVE_SECRET, GITHUB_TOKEN

const crypto = require('crypto');
const API = 'https://api.github.com';

function validateToken(rawToken) {
  const secret = process.env.APPROVE_SECRET;
  if (!secret) return { valid: false, error: 'APPROVE_SECRET not configured' };

  const dot = rawToken.lastIndexOf('.');
  if (dot === -1) return { valid: false, error: 'Malformed token' };

  const payload  = rawToken.slice(0, dot);
  const sig      = rawToken.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  if (sig.length !== expected.length) return { valid: false, error: 'Invalid token' };
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return { valid: false, error: 'Invalid token signature' };
  }

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return { valid: false, error: 'Invalid token payload' };
  }

  if (Date.now() > data.expiresAt) {
    return { valid: false, error: 'Token expired (72h limit)' };
  }

  return { valid: true, slug: data.slug, client: data.client };
}

async function ghReq(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'SEO-Squad-Reject/1.0'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API ${res.status}: ${err}`);
  }
  return res.json();
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function htmlPage(heading, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Article Rejected</title>
<style>
  body { margin: 0; font-family: -apple-system, sans-serif; background: #f5f5f7; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #fff; border-radius: 16px; padding: 48px; max-width: 480px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; border: 1px solid #e8e8e8; }
  .icon { width: 64px; height: 64px; border-radius: 50%; background: #fef2f2; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px; font-size: 28px; }
  h1 { margin: 0 0 12px; font-size: 24px; font-weight: 800; color: #dc2626; }
  p { margin: 0; color: #6e6e73; font-size: 15px; line-height: 1.6; }
  .back { display: inline-block; margin-top: 24px; padding: 12px 24px; background: #0a0a0a; border-radius: 980px; color: #fff; font-size: 14px; font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">✕</div>
  <h1>${heading}</h1>
  <p>${message}</p>
  <a class="back" href="/blog">Back to Blog</a>
</div>
</body></html>`;
}

module.exports = async function handler(req, res) {
  const token = req.query && req.query.token;

  if (!token) {
    res.status(400).setHeader('Content-Type', 'text/html').end(
      htmlPage('Missing token', 'No rejection token was provided.')
    );
    return;
  }

  const validation = validateToken(token);
  if (!validation.valid) {
    res.status(400).setHeader('Content-Type', 'text/html').end(
      htmlPage('Invalid link', validation.error + '. The rejection link may have already been used.')
    );
    return;
  }

  const { slug } = validation;
  const ghToken = process.env.GITHUB_TOKEN;

  if (ghToken) {
    try {
      const repo = process.env.GITHUB_REPO || 'ARIZN-CO/arizn-website';
      const pendingPath = encodePath(`_pending/${slug}.json`);
      const pendingFile = await ghReq('GET', `/repos/${repo}/contents/${pendingPath}`, null, ghToken);

      if (pendingFile) {
        await ghReq('DELETE', `/repos/${repo}/contents/${pendingPath}`, {
          message: `chore: reject and remove pending for ${slug} [SEO Squad]`,
          sha: pendingFile.sha
        }, ghToken);
      }
    } catch (e) {
      console.error('Reject cleanup error:', e.message);
    }
  }

  res.status(200).setHeader('Content-Type', 'text/html').end(
    htmlPage(
      'Article rejected',
      `Got it. "${slug}" will not be published. Regenerate it from the terminal: <code>npm run article -- --client=arizn</code>`
    )
  );
};
