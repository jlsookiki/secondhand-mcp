/**
 * Facebook Marketplace Detail Page - GraphQL Request Capture
 *
 * Instructions:
 * 1. Go to facebook.com/marketplace in Chrome
 * 2. Open DevTools (Cmd+Option+I) → Console tab
 * 3. Paste this entire script and press Enter
 * 4. Click on any listing to open its detail page
 * 5. The script will log all GraphQL requests with their doc_id and response structure
 * 6. Look for the one with description, photos, etc.
 */

(() => {
  let captureCount = 0;

  function analyzeResponse(docId, variables, responseText) {
    try {
      const hasDescription = /redacted_description|marketplace_listing_description|listing_description/.test(responseText);
      const hasPhotos = /listing_photos|all_listing_photos/.test(responseText);
      const hasCondition = /listing_condition|renderable_condition/.test(responseText);

      const indicators = [];
      if (hasDescription) indicators.push('DESCRIPTION');
      if (hasPhotos) indicators.push('PHOTOS');
      if (hasCondition) indicators.push('CONDITION');

      captureCount++;

      if (indicators.length > 0) {
        const json = JSON.parse(responseText);
        let vars = {};
        try { vars = JSON.parse(variables || '{}'); } catch {}

        console.group(
          `%c[MATCH #${captureCount}] doc_id: ${docId} → ${indicators.join(', ')}`,
          'color: green; font-weight: bold; font-size: 14px;'
        );
        console.log('doc_id:', docId);
        console.log('variables:', vars);

        // Find interesting keys up to 4 levels deep
        const flatKeys = new Set();
        const findKeys = (obj, prefix = '') => {
          if (!obj || typeof obj !== 'object' || prefix.split('.').length > 4) return;
          for (const [k, v] of Object.entries(obj)) {
            const path = prefix ? `${prefix}.${k}` : k;
            flatKeys.add(path);
            if (typeof v === 'object' && v !== null) findKeys(v, path);
          }
        };
        findKeys(json);

        const interestingKeys = [...flatKeys].filter(k =>
          /photo|image|description|condition|seller|delivery|shipping|location/i.test(k)
        ).sort();

        console.log('Interesting response keys:', interestingKeys);
        console.log('Full response:', json);
        console.groupEnd();
      } else {
        console.log(`[#${captureCount}] doc_id: ${docId} (no detail fields)`);
      }
    } catch (e) {
      // ignore
    }
  }

  // --- Intercept XMLHttpRequest (Facebook's primary method) ---
  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._captureUrl = url;
    this._captureMethod = method;
    return origXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this._captureUrl && this._captureUrl.includes('/api/graphql/') && body) {
      const bodyStr = typeof body === 'string' ? body : String(body);
      const params = new URLSearchParams(bodyStr);
      const docId = params.get('doc_id');
      const variables = params.get('variables');

      if (docId) {
        this.addEventListener('load', function () {
          analyzeResponse(docId, variables, this.responseText);
        });
      }
    }
    return origXHRSend.call(this, body);
  };

  // --- Intercept fetch (fallback) ---
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const [url, options] = args;
    const response = await origFetch.apply(this, args);

    if (typeof url === 'string' && url.includes('/api/graphql/') && options?.body) {
      try {
        const bodyStr = typeof options.body === 'string' ? options.body : String(options.body);
        const params = new URLSearchParams(bodyStr);
        const docId = params.get('doc_id');
        const variables = params.get('variables');

        if (docId) {
          const clone = response.clone();
          const text = await clone.text();
          analyzeResponse(docId, variables, text);
        }
      } catch {}
    }
    return response;
  };

  console.log('%c[Marketplace Capture] Monitoring XHR + fetch GraphQL requests...',
    'color: blue; font-weight: bold; font-size: 16px;');
  console.log('Now click on a listing! Matches with description/photos/condition will be green.');
  console.log('To stop: refresh the page.');
})();
