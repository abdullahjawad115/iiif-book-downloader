// ==UserScript==
// @name         IIIF Book Downloader
// @namespace    https://github.com/abdullahjawad115
// @version      6.0
// @description  Download page images from any IIIF manifest (Presentation API v2 or v3), with page-range selection and live progress.
// @author       Abdullah Jawadwala
// @license      MIT
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

/*
 * How it works
 * ------------
 * IIIF (International Image Interoperability Framework) is an open standard that
 * many libraries, museums and archives use to publish digitised books. Each book
 * has a "manifest": a JSON file that lists its pages and the image service for
 * each page.
 *
 * This script:
 *   1. Finds a manifest URL on the current page, or asks you for one.
 *   2. Fetches the manifest and walks it recursively to collect every page's
 *      image service, in reading order (works for both v2 and v3 manifests).
 *   3. Lets you choose the whole book or a custom page range.
 *   4. Downloads each page as a full-resolution JPEG, one at a time, with progress.
 *
 * Tip: the @match line in the header makes the script available on every site.
 * To keep it quiet elsewhere, change it to the address of the library you use.
 */

(function () {
  'use strict';

  const DELAY_BETWEEN_PAGES_MS = 300; // be polite to the library's servers

  // Keys that point at things other than the book's pages (thumbnails, logos,
  // related documents). Skipping them stops thumbnails being saved as pages.
  const SKIP_KEYS = new Set(['thumbnail', 'logo', 'rendering', 'seeAlso', 'partOf', 'homepage', 'provider', 'start']);

  // ---------------------------------------------------------------------------
  // 1. Finding the manifest
  // ---------------------------------------------------------------------------

  /** Looks for a IIIF manifest URL in the page address and in links on the page. */
  function findManifestUrl() {
    // Many viewers put it in the address, e.g. ?manifest=https://.../manifest.json
    const params = new URLSearchParams(location.search);
    for (const key of ['manifest', 'iiif-content', 'iiif_manifest']) {
      const value = params.get(key);
      if (value && /^https?:\/\//.test(value)) return value;
    }

    // Otherwise look for links or data attributes that mention a manifest.
    const candidates = document.querySelectorAll(
      'a[href*="manifest"], link[href*="manifest"], [data-manifest], [data-manifest-url]'
    );
    for (const el of candidates) {
      const raw = el.getAttribute('data-manifest') || el.getAttribute('data-manifest-url') || el.getAttribute('href');
      if (!raw) continue;
      const url = new URL(raw, location.href);
      // Links like viewer.html?manifest=... carry the manifest as a parameter.
      const nested = url.searchParams.get('manifest');
      if (nested) return nested;
      if (/manifest/i.test(url.pathname)) return url.href;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 2. Fetching and parsing the manifest
  // ---------------------------------------------------------------------------

  function fetchJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { Accept: 'application/ld+json, application/json' },
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) return reject(new Error(`HTTP ${res.status} for ${url}`));
          try {
            resolve(JSON.parse(res.responseText));
          } catch (err) {
            reject(new Error('The manifest is not valid JSON.'));
          }
        },
        onerror: () => reject(new Error(`Network error while fetching ${url}`)),
      });
    });
  }

  /** True if this object describes a IIIF Image API service. */
  function isImageService(obj) {
    const type = obj['@type'] || obj.type || '';
    const context = [].concat(obj['@context'] || []).join(' ');
    const profile = [].concat(obj.profile || []).map((p) => (typeof p === 'string' ? p : '')).join(' ');
    return (
      /ImageService[123]/.test(type) ||
      context.includes('iiif.io/api/image') ||
      profile.includes('iiif.io/api/image')
    );
  }

  /** Image API 3 uses "max" for the largest size; version 2 uses "full". */
  function imageApiVersion(service) {
    const type = service['@type'] || service.type || '';
    const context = [].concat(service['@context'] || []).join(' ');
    if (type === 'ImageService3' || context.includes('image/3')) return 3;
    return 2;
  }

  /**
   * Recursively walks any manifest structure and collects image services in the
   * order they appear, which is the book's reading order. Version-agnostic:
   * v2 nests them under sequences > canvases > images > resource > service,
   * v3 under items > items > items > body > service.
   */
  function collectImageServices(node, found = new Map()) {
    if (!node || typeof node !== 'object') return found;

    if (Array.isArray(node)) {
      for (const item of node) collectImageServices(item, found);
      return found;
    }

    if (isImageService(node)) {
      const id = (node['@id'] || node.id || '').replace(/\/info\.json$/, '').replace(/\/$/, '');
      if (id && !found.has(id)) found.set(id, imageApiVersion(node));
      return found; // a service never contains page images of its own
    }

    for (const [key, value] of Object.entries(node)) {
      if (SKIP_KEYS.has(key)) continue;
      if (value && typeof value === 'object') collectImageServices(value, found);
    }
    return found;
  }

  /** Builds the URL for the largest available JPEG of one page. */
  function fullImageUrl(serviceId, version) {
    const size = version === 3 ? 'max' : 'full';
    return `${serviceId}/full/${size}/0/default.jpg`;
  }

  /** Manifest labels can be plain strings (v2) or language maps (v3). */
  function readLabel(label) {
    if (!label) return '';
    if (typeof label === 'string') return label;
    if (Array.isArray(label)) return readLabel(label[0]);
    if (label['@value']) return label['@value'];
    const firstLanguage = Object.values(label)[0];
    return Array.isArray(firstLanguage) ? firstLanguage[0] : String(firstLanguage || '');
  }

  function safeFolderName(text) {
    const cleaned = text.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    return cleaned || 'iiif-book';
  }

  // ---------------------------------------------------------------------------
  // 3. Choosing pages
  // ---------------------------------------------------------------------------

  /** Turns input like "1-10, 15, 20-25" into sorted zero-based page indices. */
  function parsePageSelection(input, totalPages) {
    const indices = new Set();
    for (const part of input.split(',').map((p) => p.trim()).filter(Boolean)) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map((n) => parseInt(n.trim(), 10));
        if (Number.isNaN(start) || Number.isNaN(end)) continue;
        const from = Math.max(1, Math.min(start, end));
        const to = Math.min(totalPages, Math.max(start, end));
        for (let page = from; page <= to; page++) indices.add(page - 1);
      } else {
        const page = parseInt(part, 10);
        if (page >= 1 && page <= totalPages) indices.add(page - 1);
      }
    }
    return [...indices].sort((a, b) => a - b);
  }

  /** Shows a small dialog and resolves with the chosen page indices, or null. */
  function askForPages(title, totalPages) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483646;display:flex;align-items:center;justify-content:center';

      const box = document.createElement('div');
      box.style.cssText =
        'background:#fff;color:#1f2937;padding:24px;border-radius:12px;width:min(380px,90vw);font:14px/1.5 sans-serif;box-shadow:0 10px 25px rgba(0,0,0,.25)';
      box.innerHTML = `
        <h3 style="margin:0 0 4px;font-size:18px">Download pages</h3>
        <p style="margin:0 0 4px;color:#4b5563" class="iiif-title"></p>
        <p style="margin:0 0 16px;color:#4b5563">${totalPages} pages found</p>
        <label style="display:flex;gap:8px;margin-bottom:10px;cursor:pointer">
          <input type="radio" name="iiif-range" value="all" checked> Whole book (1–${totalPages})
        </label>
        <label style="display:flex;gap:8px;cursor:pointer">
          <input type="radio" name="iiif-range" value="custom"> Custom range
        </label>
        <input type="text" class="iiif-custom" placeholder="e.g. 1-10, 15, 20-25" disabled
          style="margin:6px 0 16px;width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box">
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button class="iiif-cancel" style="padding:8px 16px;border:0;border-radius:6px;background:#e5e7eb;cursor:pointer">Cancel</button>
          <button class="iiif-start" style="padding:8px 16px;border:0;border-radius:6px;background:#2563eb;color:#fff;font-weight:bold;cursor:pointer">Start download</button>
        </div>`;
      box.querySelector('.iiif-title').textContent = title; // textContent, so a label can't inject HTML

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const customInput = box.querySelector('.iiif-custom');
      box.querySelectorAll('input[name="iiif-range"]').forEach((radio) =>
        radio.addEventListener('change', () => {
          customInput.disabled = radio.value !== 'custom' || !radio.checked;
          if (!customInput.disabled) customInput.focus();
        })
      );

      const close = (result) => {
        overlay.remove();
        resolve(result);
      };
      box.querySelector('.iiif-cancel').addEventListener('click', () => close(null));
      box.querySelector('.iiif-start').addEventListener('click', () => {
        const choice = box.querySelector('input[name="iiif-range"]:checked').value;
        close(
          choice === 'all'
            ? Array.from({ length: totalPages }, (_, i) => i)
            : parsePageSelection(customInput.value, totalPages)
        );
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Downloading
  // ---------------------------------------------------------------------------

  function downloadFile(url, name) {
    return new Promise((resolve) => {
      GM_download({
        url,
        name,
        onload: () => resolve(true),
        onerror: (err) => {
          console.error(`[IIIF] Failed: ${name}`, err);
          resolve(false); // keep going; report failures at the end
        },
      });
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let button = null;
  let busy = false;

  function setStatus(text, color = '#2563eb') {
    if (!button) return;
    button.textContent = text;
    button.style.backgroundColor = color;
  }

  async function run(manifestUrl) {
    if (busy) return;
    busy = true;
    if (button) button.disabled = true;

    try {
      setStatus('⏳ Reading manifest…');
      const manifest = await fetchJson(manifestUrl);
      const services = [...collectImageServices(manifest).entries()];
      if (services.length === 0) throw new Error('No page images were found in this manifest.');

      const title = readLabel(manifest.label) || 'Untitled';
      const pages = await askForPages(title, services.length);
      if (!pages || pages.length === 0) return;

      const folder = safeFolderName(title);
      let failed = 0;
      for (let i = 0; i < pages.length; i++) {
        const index = pages[i];
        const [serviceId, version] = services[index];
        const pageNumber = String(index + 1).padStart(4, '0');
        setStatus(`⏳ Saving ${i + 1}/${pages.length}…`);
        const ok = await downloadFile(fullImageUrl(serviceId, version), `${folder}/page_${pageNumber}.jpg`);
        if (!ok) failed++;
        await sleep(DELAY_BETWEEN_PAGES_MS);
      }

      if (failed) {
        setStatus(`⚠️ Done, ${failed} page(s) failed (see console)`, '#d97706');
      } else {
        setStatus('✅ Complete', '#16a34a');
      }
    } catch (err) {
      console.error('[IIIF]', err);
      alert(err.message);
      setStatus('❌ Failed', '#b91c1c');
    } finally {
      busy = false;
      if (button) button.disabled = false;
      setTimeout(() => setStatus('📥 Download book (IIIF)'), 4000);
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Wiring it into the page
  // ---------------------------------------------------------------------------

  function promptForManifest() {
    const url = prompt('Paste the IIIF manifest URL:', findManifestUrl() || '');
    if (url) run(url.trim());
  }

  function addButton() {
    if (document.getElementById('iiif-dl-btn')) return;
    button = document.createElement('button');
    button.id = 'iiif-dl-btn';
    button.style.cssText =
      'position:fixed;top:20px;right:20px;z-index:2147483645;padding:12px 20px;color:#fff;border:0;border-radius:8px;font:bold 14px sans-serif;cursor:pointer;box-shadow:0 4px 6px rgba(0,0,0,.3)';
    setStatus('📥 Download book (IIIF)');
    button.addEventListener('click', () => {
      const manifestUrl = findManifestUrl();
      manifestUrl ? run(manifestUrl) : promptForManifest();
    });
    document.body.appendChild(button);
  }

  // Always available from the Tampermonkey menu, on any page.
  GM_registerMenuCommand('Download from a IIIF manifest…', promptForManifest);

  // Show the floating button only on pages that actually contain a manifest.
  // Single-page viewers change content without reloading, so check periodically.
  setInterval(() => {
    const hasManifest = Boolean(findManifestUrl());
    const existing = document.getElementById('iiif-dl-btn');
    if (hasManifest && !existing) addButton();
    if (!hasManifest && existing && !busy) existing.remove();
  }, 1500);
})();
