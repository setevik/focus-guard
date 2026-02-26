/**
 * Domain matching utilities.
 * Extracts registrable domains and matches URLs against rules.
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

  // Check for multi-part TLDs
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) {
    return parts.slice(-3).join('.');
  }

  return parts.slice(-2).join('.');
}

/**
 * Extract domain from a URL string.
 * Returns null for non-http(s) URLs.
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
 * Check if a hostname matches a rule's domain.
 */
export function domainMatches(hostname, ruleDomain, matchSubdomains) {
  const registrable = getRegistrableDomain(hostname);
  if (matchSubdomains) {
    return registrable === ruleDomain;
  }
  return hostname === ruleDomain;
}

/**
 * Find the rule that matches a given URL.
 */
export function findMatchingRule(url, rules) {
  const domain = getDomainFromUrl(url);
  if (!domain) return null;

  try {
    const hostname = new URL(url).hostname;
    for (const rule of rules) {
      if (domainMatches(hostname, rule.domain, rule.matchSubdomains)) {
        return rule;
      }
    }
  } catch {
    // invalid URL
  }
  return null;
}
