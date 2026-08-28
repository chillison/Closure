/**
 * Wiki site registry (Story 3.6 WP3, R1 / design D8).
 *
 * A wiki site = one MediaWiki installation speaking the endpoints this story
 * probes (2026-08-15 本机实探, prd Background):
 *
 *   - `api.php?action=opensearch`  — title-prefix search (works on BOTH sites)
 *   - `api.php?action=query&list=search` — fulltext search (official BLOCKS it:
 *     action-notallowed; the mirror allows everything)
 *   - `api.php?action=parse&prop=wikitext` — page wikitext (official BLOCKS it;
 *     mirror allows it → serves as the wiki_read degradation path)
 *   - `rest.php/v1/page/{title}` — page wikitext + license (works on both;
 *     follows redirects by title)
 *
 * `searchKind` therefore encodes what `wiki_search` USES per site:
 * 'opensearch' = the official site can only do prefix search; 'fulltext' =
 * the mirror serves list=search (fulltext ⊇ prefix). `fulltextOnMirror` marks
 * api.php-wide availability (mirror-grade), which wiki_read consumes to pick
 * its degraded read path (`api.php?action=parse`).
 *
 * MediaWiki universality (R1): any site speaking the same protocol — PRTS
 * (prts.wiki), bwiki (wiki.biligame.com/<game>), Fandom, … — plugs in by
 * adding a registry entry. Custom user sites arrive via the WP10 settings page
 * (design D14 「预设只读+自定义增删」): they persist as `wikiSitesOverrides` in
 * the search-config sidecar and flow through the `loadWikiSites(overrides?)`
 * seam here (wikiHandlers resolves them per call, so a settings edit takes
 * effect on the next tool invocation without a restart).
 *
 * Pure data + pure functions — no electron, no network (table-testable).
 */

/** How `wiki_search` queries this site (official api.php blocks fulltext). */
export type WikiSearchKind = 'opensearch' | 'fulltext';

export interface WikiSite {
  /** Stable tool-param id (e.g. 'moegirl-cn'). */
  id: string;
  /** Human-readable name shown in tool outputs. */
  name: string;
  /** API base URL WITHOUT trailing slash — endpoints hang off the root (`/api.php`, `/rest.php`). */
  apiBaseUrl: string;
  searchKind: WikiSearchKind;
  /**
   * This site's api.php is fully accessible (mirror-grade). wiki_read uses it
   * to pick the degraded path: mirror-capable sites serve `api.php?action=parse`;
   * the official site (flag unset) does not (action-notallowed).
   */
  fulltextOnMirror?: boolean;
}

/**
 * Hardcoded presets (D8). Registry ORDER is merge priority for wiki_search
 * 'auto' dedup (official first) and fallback order for wiki_read degradation.
 */
export const WIKI_SITE_PRESETS: readonly WikiSite[] = [
  {
    id: 'moegirl-cn',
    name: '萌娘百科（官方站）',
    apiBaseUrl: 'https://zh.moegirl.org.cn',
    // 官方站 api.php query/parse 被拦（action-notallowed，2026-08-15 实探）——仅前缀搜索。
    searchKind: 'opensearch',
  },
  {
    id: 'moegirl-uk',
    name: '萌娘百科（镜像站）',
    apiBaseUrl: 'https://moegirl.uk',
    // 镜像站 api.php 全通（list=search 全文 + parse + rest.php）；Cloudflare 拦
    // Special:Export（勿用）。api.php 不拦。
    searchKind: 'fulltext',
    fulltextOnMirror: true,
  },
];

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Resolve the active site list: presets (read-only, D14) plus caller-supplied
 * custom sites. A custom site whose id collides with a preset is DROPPED —
 * presets are read-only by design; the WP10 settings surface enforces this
 * before persisting, this is the last-line guard. Base URLs are normalized
 * (trailing slashes stripped) so URL builders can concatenate naively.
 */
export function loadWikiSites(overrides?: readonly WikiSite[]): WikiSite[] {
  const sites: WikiSite[] = WIKI_SITE_PRESETS.map((s) => ({ ...s, apiBaseUrl: normalizeBaseUrl(s.apiBaseUrl) }));
  if (!overrides) return sites;
  const ids = new Set(sites.map((s) => s.id));
  for (const override of overrides) {
    if (!override || typeof override.id !== 'string' || ids.has(override.id)) continue;
    ids.add(override.id);
    sites.push({ ...override, apiBaseUrl: normalizeBaseUrl(override.apiBaseUrl) });
  }
  return sites;
}
