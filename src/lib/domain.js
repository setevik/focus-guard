/**
 * Domain matching and canonicalization utilities.
 * All identities are normalized to registrable domains.
 */

// Known multi-part TLDs (common ones)
const MULTI_PART_TLDS = new Set([
  'co.uk', 'co.il', 'co.jp', 'co.kr', 'co.nz', 'co.za', 'co.in',
  'com.au', 'com.br', 'com.cn', 'com.mx', 'com.tr', 'com.tw',
  'org.uk', 'org.au', 'net.au', 'ac.uk', 'gov.uk',
]);

/**
 * Extract the registrable domain from a hostname.
 * e.g. "www.reddit.com" → "reddit.com", "news.ynet.co.il" → "ynet.co.il"
 */
export function getRegistrableDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;

  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) {
    return parts.slice(-3).join('.');
  }

  return parts.slice(-2).join('.');
}

/**
 * Extract registrable domain from a URL string.
 * Returns null for non-http(s) URLs or invalid input.
 */
export function getDomainFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return getRegistrableDomain(parsed.hostname);
  } catch {
    return null;
  }
}

/**
 * Check if a hostname matches a rule's domain (which is always a registrable domain).
 *
 * matchSubdomains=true  → any subdomain of the registrable domain matches
 * matchSubdomains=false → only the exact hostname matches
 */
export function domainMatches(hostname, ruleDomain, matchSubdomains) {
  if (matchSubdomains) {
    return getRegistrableDomain(hostname) === ruleDomain;
  }
  return hostname === ruleDomain;
}

/**
 * Find the rule that matches a given URL.
 * Returns the matching rule or null.
 */
export function findMatchingRule(url, rules) {
  if (!rules || rules.length === 0) return null;

  let hostname;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    hostname = parsed.hostname;
  } catch {
    return null;
  }

  for (const rule of rules) {
    if (domainMatches(hostname, rule.domain, rule.matchSubdomains)) {
      return rule;
    }
  }
  return null;
}

/**
 * Canonicalize user input into a registrable domain.
 *
 * Handles:
 *  - Full URLs ("https://www.reddit.com/r/foo") → "reddit.com"
 *  - Hostnames with port ("reddit.com:443") → "reddit.com"
 *  - Bare domains ("reddit.com") → "reddit.com"
 *  - Subdomains ("old.reddit.com") → "reddit.com"
 *  - Mixed case ("Reddit.COM") → "reddit.com"
 *  - Trailing dots / slashes
 *
 * Returns the canonical registrable domain, or null if input is invalid.
 */
export function canonicalizeDomain(input) {
  if (!input || typeof input !== 'string') return null;

  let cleaned = input.trim().toLowerCase();
  if (!cleaned) return null;

  // If it looks like a URL, parse the hostname out
  if (cleaned.includes('://')) {
    try {
      const parsed = new URL(cleaned);
      cleaned = parsed.hostname;
    } catch {
      return null;
    }
  } else {
    // Strip anything after the first slash (path)
    cleaned = cleaned.split('/')[0];
    // Strip port
    cleaned = cleaned.replace(/:\d+$/, '');
  }

  // Strip trailing dot (FQDN notation)
  cleaned = cleaned.replace(/\.$/, '');

  // Validate: must look like a hostname (letters, digits, hyphens, dots)
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(cleaned)) {
    return null;
  }

  return getRegistrableDomain(cleaned);
}
