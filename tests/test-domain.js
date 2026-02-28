import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getRegistrableDomain,
  getDomainFromUrl,
  domainMatches,
  findMatchingRule,
  canonicalizeDomain,
} from '../src/lib/domain.js';

// ── getRegistrableDomain ───────────────────────────────────────

describe('getRegistrableDomain', () => {
  it('returns simple two-part domains as-is', () => {
    assert.equal(getRegistrableDomain('reddit.com'), 'reddit.com');
    assert.equal(getRegistrableDomain('example.org'), 'example.org');
  });

  it('strips subdomains', () => {
    assert.equal(getRegistrableDomain('www.reddit.com'), 'reddit.com');
    assert.equal(getRegistrableDomain('old.reddit.com'), 'reddit.com');
    assert.equal(getRegistrableDomain('a.b.c.reddit.com'), 'reddit.com');
  });

  it('handles multi-part TLDs', () => {
    assert.equal(getRegistrableDomain('ynet.co.il'), 'ynet.co.il');
    assert.equal(getRegistrableDomain('news.ynet.co.il'), 'ynet.co.il');
    assert.equal(getRegistrableDomain('bbc.co.uk'), 'bbc.co.uk');
    assert.equal(getRegistrableDomain('www.bbc.co.uk'), 'bbc.co.uk');
    assert.equal(getRegistrableDomain('abc.com.au'), 'abc.com.au');
  });

  it('returns single-label hostnames as-is', () => {
    assert.equal(getRegistrableDomain('localhost'), 'localhost');
  });
});

// ── getDomainFromUrl ───────────────────────────────────────────

describe('getDomainFromUrl', () => {
  it('extracts registrable domain from http URLs', () => {
    assert.equal(getDomainFromUrl('http://www.reddit.com/r/foo'), 'reddit.com');
    assert.equal(getDomainFromUrl('https://old.reddit.com'), 'reddit.com');
  });

  it('handles URLs with ports and paths', () => {
    assert.equal(getDomainFromUrl('https://example.com:8080/path?q=1'), 'example.com');
  });

  it('handles multi-part TLDs in URLs', () => {
    assert.equal(getDomainFromUrl('https://news.ynet.co.il/article/123'), 'ynet.co.il');
  });

  it('returns null for non-http protocols', () => {
    assert.equal(getDomainFromUrl('ftp://example.com'), null);
    assert.equal(getDomainFromUrl('file:///tmp/foo'), null);
    assert.equal(getDomainFromUrl('about:blank'), null);
  });

  it('returns null for invalid URLs', () => {
    assert.equal(getDomainFromUrl('not a url'), null);
    assert.equal(getDomainFromUrl(''), null);
  });
});

// ── domainMatches ──────────────────────────────────────────────

describe('domainMatches', () => {
  it('with matchSubdomains=true, matches any subdomain', () => {
    assert.equal(domainMatches('www.reddit.com', 'reddit.com', true), true);
    assert.equal(domainMatches('old.reddit.com', 'reddit.com', true), true);
    assert.equal(domainMatches('reddit.com', 'reddit.com', true), true);
  });

  it('with matchSubdomains=true, rejects different domains', () => {
    assert.equal(domainMatches('www.example.com', 'reddit.com', true), false);
  });

  it('with matchSubdomains=false, requires exact hostname', () => {
    assert.equal(domainMatches('reddit.com', 'reddit.com', false), true);
    assert.equal(domainMatches('www.reddit.com', 'reddit.com', false), false);
    assert.equal(domainMatches('old.reddit.com', 'reddit.com', false), false);
  });
});

// ── findMatchingRule ───────────────────────────────────────────

describe('findMatchingRule', () => {
  const rules = [
    { domain: 'reddit.com', allowedMinutes: 5, windowMinutes: 180, matchSubdomains: true },
    { domain: 'ynet.co.il', allowedMinutes: 3, windowMinutes: 120, matchSubdomains: true },
    { domain: 'example.com', allowedMinutes: 10, windowMinutes: 60, matchSubdomains: false },
  ];

  it('matches subdomain rules', () => {
    const rule = findMatchingRule('https://www.reddit.com/r/foo', rules);
    assert.equal(rule.domain, 'reddit.com');
  });

  it('matches multi-part TLD rules', () => {
    const rule = findMatchingRule('https://news.ynet.co.il/article', rules);
    assert.equal(rule.domain, 'ynet.co.il');
  });

  it('exact-only rule matches apex hostname', () => {
    const rule = findMatchingRule('https://example.com/page', rules);
    assert.equal(rule.domain, 'example.com');
  });

  it('exact-only rule rejects subdomains', () => {
    const rule = findMatchingRule('https://www.example.com/page', rules);
    assert.equal(rule, null);
  });

  it('returns null for non-matching URLs', () => {
    assert.equal(findMatchingRule('https://google.com', rules), null);
  });

  it('returns null for non-http URLs', () => {
    assert.equal(findMatchingRule('about:blank', rules), null);
    assert.equal(findMatchingRule('ftp://reddit.com', rules), null);
  });

  it('returns null for empty rules', () => {
    assert.equal(findMatchingRule('https://reddit.com', []), null);
    assert.equal(findMatchingRule('https://reddit.com', null), null);
  });
});

// ── canonicalizeDomain ─────────────────────────────────────────

describe('canonicalizeDomain', () => {
  it('normalizes bare domains', () => {
    assert.equal(canonicalizeDomain('reddit.com'), 'reddit.com');
    assert.equal(canonicalizeDomain('Reddit.COM'), 'reddit.com');
    assert.equal(canonicalizeDomain('  reddit.com  '), 'reddit.com');
  });

  it('extracts domain from full URLs', () => {
    assert.equal(canonicalizeDomain('https://www.reddit.com/r/foo?q=1'), 'reddit.com');
    assert.equal(canonicalizeDomain('http://old.reddit.com'), 'reddit.com');
  });

  it('strips port numbers', () => {
    assert.equal(canonicalizeDomain('example.com:8080'), 'example.com');
  });

  it('strips paths from bare hostnames', () => {
    assert.equal(canonicalizeDomain('reddit.com/r/programming'), 'reddit.com');
  });

  it('strips trailing dots', () => {
    assert.equal(canonicalizeDomain('reddit.com.'), 'reddit.com');
  });

  it('extracts registrable domain from subdomains', () => {
    assert.equal(canonicalizeDomain('old.reddit.com'), 'reddit.com');
    assert.equal(canonicalizeDomain('news.ynet.co.il'), 'ynet.co.il');
  });

  it('handles multi-part TLDs', () => {
    assert.equal(canonicalizeDomain('https://www.bbc.co.uk/news'), 'bbc.co.uk');
  });

  it('rejects invalid input', () => {
    assert.equal(canonicalizeDomain(''), null);
    assert.equal(canonicalizeDomain(null), null);
    assert.equal(canonicalizeDomain('not valid!'), null);
    assert.equal(canonicalizeDomain('just-a-word'), null);
    assert.equal(canonicalizeDomain('.com'), null);
  });
});
