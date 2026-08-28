/**
 * Wiki site registry tests (Story 3.6 WP3 / design D8).
 *
 * Locks the two hardcoded presets (ids, protocol strategy, mirror flag — the
 * 2026-08-15 实探 facts the handlers branch on), the loadWikiSites override
 * seam reserved for WP10, and normalization behavior. Pure data — zero network.
 */
import { describe, expect, it } from 'vitest';
import { WIKI_SITE_PRESETS, loadWikiSites, type WikiSite } from '../main/research/wikiSites';

describe('WIKI_SITE_PRESETS (D8)', () => {
  it('contains exactly moegirl-cn (opensearch) then moegirl-uk (fulltext mirror)', () => {
    expect(WIKI_SITE_PRESETS.map((s) => s.id)).toEqual(['moegirl-cn', 'moegirl-uk']);

    const official = WIKI_SITE_PRESETS[0];
    expect(official.name).toContain('官方');
    expect(official.apiBaseUrl).toBe('https://zh.moegirl.org.cn');
    expect(official.searchKind).toBe('opensearch'); // 官方 api.php query/parse 被拦 → 仅前缀
    expect(official.fulltextOnMirror).toBeUndefined();

    const mirror = WIKI_SITE_PRESETS[1];
    expect(mirror.apiBaseUrl).toBe('https://moegirl.uk');
    expect(mirror.searchKind).toBe('fulltext'); // 镜像 list=search 全文
    expect(mirror.fulltextOnMirror).toBe(true); // api.php parse 可用 → wiki_read 降级目标
  });

  it('preset base URLs carry no trailing slash (builders concatenate naively)', () => {
    for (const site of WIKI_SITE_PRESETS) {
      expect(site.apiBaseUrl.endsWith('/')).toBe(false);
    }
  });
});

describe('loadWikiSites', () => {
  it('returns FRESH copies — mutating the result cannot corrupt the presets', () => {
    const sites = loadWikiSites();
    sites.push({ id: 'injected', name: 'x', apiBaseUrl: 'https://x.example.com', searchKind: 'fulltext' });
    expect(loadWikiSites()).toHaveLength(2);
    expect(WIKI_SITE_PRESETS).toHaveLength(2);
  });

  it('appends custom sites after the presets (WP10 seam, registry order = merge priority)', () => {
    const prts: WikiSite = { id: 'prts', name: 'PRTS', apiBaseUrl: 'https://prts.wiki', searchKind: 'fulltext', fulltextOnMirror: true };
    const sites = loadWikiSites([prts]);
    expect(sites.map((s) => s.id)).toEqual(['moegirl-cn', 'moegirl-uk', 'prts']);
  });

  it('DROPS a custom site whose id collides with a preset (presets are read-only, D14)', () => {
    const impostor: WikiSite = { id: 'moegirl-cn', name: 'fake', apiBaseUrl: 'https://evil.example.com', searchKind: 'fulltext' };
    const sites = loadWikiSites([impostor]);
    expect(sites).toHaveLength(2);
    expect(sites[0].apiBaseUrl).toBe('https://zh.moegirl.org.cn');
  });

  it('normalizes trailing slashes off override base URLs', () => {
    const sites = loadWikiSites([{ id: 'fandom-test', name: 'Fandom', apiBaseUrl: 'https://test.fandom.com///', searchKind: 'opensearch' }]);
    expect(sites[2].apiBaseUrl).toBe('https://test.fandom.com');
  });
});
