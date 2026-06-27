'use strict';
// Vercel Serverless Function — GET /api/approve?token=XXX
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
      'User-Agent': 'SEO-Squad-Approve/1.0'
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

function htmlPage(title, heading, message, isSuccess) {
  const color = isSuccess ? '#16a34a' : '#dc2626';
  const bg    = isSuccess ? '#f0fdf4' : '#fef2f2';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title}</title>
<style>
  body { margin: 0; font-family: -apple-system, sans-serif; background: #f5f5f7; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #fff; border-radius: 16px; padding: 48px; max-width: 480px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; border: 1px solid #e8e8e8; }
  .icon { width: 64px; height: 64px; border-radius: 50%; background: ${bg}; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px; font-size: 28px; }
  h1 { margin: 0 0 12px; font-size: 24px; font-weight: 800; color: ${color}; }
  p { margin: 0; color: #6e6e73; font-size: 15px; line-height: 1.6; }
  a { color: #1A56FF; }
  .back { display: inline-block; margin-top: 24px; padding: 12px 24px; background: #0a0a0a; border-radius: 980px; color: #fff; font-size: 14px; font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">${isSuccess ? '✓' : '✗'}</div>
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
      htmlPage('Invalid', 'Missing token', 'No approval token was provided.', false)
    );
    return;
  }

  const validation = validateToken(token);
  if (!validation.valid) {
    res.status(400).setHeader('Content-Type', 'text/html').end(
      htmlPage('Invalid Token', 'Approval link expired or invalid', validation.error + '. Request a new article run to get a fresh link.', false)
    );
    return;
  }

  const { slug } = validation;
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) {
    res.status(500).setHeader('Content-Type', 'text/html').end(
      htmlPage('Error', 'Server misconfigured', 'GITHUB_TOKEN is not set. Contact the site admin.', false)
    );
    return;
  }

  try {
    // Fetch pending metadata from GitHub
    const pendingPath = encodePath(`_pending/${slug}.json`);
    const pendingFile = await ghReq('GET', `/repos/${process.env.GITHUB_REPO || 'ARIZN-CO/arizn-website'}/contents/${pendingPath}`, null, ghToken);

    let pendingData = null;
    let repo = process.env.GITHUB_REPO || 'ARIZN-CO/arizn-website';
    let blogPath = 'blog';
    let siteUrl = '';
    let cardHtml = '';
    let articleUrl = '';

    if (pendingFile) {
      pendingData = JSON.parse(Buffer.from(pendingFile.content, 'base64').toString());
      repo      = pendingData.repo      || repo;
      blogPath  = pendingData.blog_path || blogPath;
      siteUrl   = pendingData.site_url  || siteUrl;
      cardHtml  = pendingData.cardHtml  || '';
      articleUrl = pendingData.articleUrl || `${siteUrl}/${blogPath}/${slug}`;
    }

    // Fetch blog/index.html from GitHub
    const indexPath = encodePath(`${blogPath}/index.html`);
    const indexFile = await ghReq('GET', `/repos/${repo}/contents/${indexPath}`, null, ghToken);
    if (!indexFile) throw new Error(`${blogPath}/index.html not found in ${repo}`);

    const current = Buffer.from(indexFile.content, 'base64').toString('utf8');

    if (current.includes(`<!-- ARTICLE:${slug} -->`)) {
      // Already published — clean up pending file if it still exists
      if (pendingFile) {
        await ghReq('DELETE', `/repos/${repo}/contents/${pendingPath}`, {
          message: `chore: clean up duplicate pending for ${slug} [SEO Squad]`,
          sha: pendingFile.sha
        }, ghToken);
      }
      res.status(200).setHeader('Content-Type', 'text/html').end(
        htmlPage('Already Live', 'Article already published', `The article "${slug}" is already live on the blog.`, true)
      );
      return;
    }

    // Inject card into blog/index.html
    let updated;
    if (current.includes('<!-- ARTICLES_START -->')) {
      updated = current.replace('<!-- ARTICLES_START -->', `<!-- ARTICLES_START -->${cardHtml}`);
    } else if (current.includes('<div class="blog-grid">')) {
      updated = current.replace(
        '<div class="blog-grid">',
        `<div class="blog-grid">\n          <!-- ARTICLES_START -->${cardHtml}`
      );
    } else {
      throw new Error('Cannot find injection point in blog/index.html');
    }

    await ghReq('PUT', `/repos/${repo}/contents/${indexPath}`, {
      message: `feat(blog): publish ${slug} via approval button [SEO Squad]`,
      content: Buffer.from(updated).toString('base64'),
      sha: indexFile.sha
    }, ghToken);

    // Delete pending file
    if (pendingFile) {
      await ghReq('DELETE', `/repos/${repo}/contents/${pendingPath}`, {
        message: `chore: remove pending file for ${slug} [SEO Squad]`,
        sha: pendingFile.sha
      }, ghToken);
    }

    res.status(200).setHeader('Content-Type', 'text/html').end(
      htmlPage(
        'Published!',
        'Article is live!',
        `"${slug}" has been published to the blog. Vercel will deploy it in ~30 seconds. <a href="${articleUrl}">View article →</a>`,
        true
      )
    );
  } catch (e) {
    console.error('Approve error:', e);
    res.status(500).setHeader('Content-Type', 'text/html').end(
      htmlPage('Error', 'Something went wrong', `Could not publish article: ${e.message}`, false)
    );
  }
};
