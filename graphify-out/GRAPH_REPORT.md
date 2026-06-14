# Graph Report - /Users/abdullahmohd/Desktop/backend-server-repo  (2026-05-07)

## Corpus Check
- Corpus is ~27,441 words - fits in a single context window. You may not need a graph.

## Summary
- 387 nodes · 804 edges · 18 communities detected
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 27 edges (avg confidence: 0.79)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Playwright Browser Automation|Playwright Browser Automation]]
- [[_COMMUNITY_Proxy Playlist Rewriting|Proxy Playlist Rewriting]]
- [[_COMMUNITY_Express Runtime Routes|Express Runtime Routes]]
- [[_COMMUNITY_Stream Detection Utilities|Stream Detection Utilities]]
- [[_COMMUNITY_NOVA Catalog Routes|NOVA Catalog Routes]]
- [[_COMMUNITY_Resolve Queue Playback URLs|Resolve Queue Playback URLs]]
- [[_COMMUNITY_Provider Fetch Utilities|Provider Fetch Utilities]]
- [[_COMMUNITY_Resolved Stream Caching|Resolved Stream Caching]]
- [[_COMMUNITY_NOVA Browser Player UI|NOVA Browser Player UI]]
- [[_COMMUNITY_Videasy Proxy Fetch|Videasy Proxy Fetch]]
- [[_COMMUNITY_Embedded Header Normalization|Embedded Header Normalization]]
- [[_COMMUNITY_Playlist Quality Extraction|Playlist Quality Extraction]]
- [[_COMMUNITY_Vidzee Stream Probing|Vidzee Stream Probing]]
- [[_COMMUNITY_Videasy Resolver Logic|Videasy Resolver Logic]]
- [[_COMMUNITY_Subtitle Normalization|Subtitle Normalization]]
- [[_COMMUNITY_Vidrock Resolver Logic|Vidrock Resolver Logic]]
- [[_COMMUNITY_CORS Server Bootstrap|CORS Server Bootstrap]]
- [[_COMMUNITY_Demo Player UI|Demo Player UI]]

## God Nodes (most connected - your core abstractions)
1. `extractVideoUrls()` - 32 edges
2. `resolveVideasySource()` - 16 edges
3. `tryResolveVideasyDirect()` - 16 edges
4. `attachQualities()` - 15 edges
5. `resolveStream()` - 15 edges
6. `validateHlsPlaybackTarget()` - 14 edges
7. `detectType()` - 13 edges
8. `tryResolveVidrockDirect()` - 13 edges
9. `tryResolveVidkingDirect()` - 12 edges
10. `createBrowserContext()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `Videasy API Router` --semantically_similar_to--> `Playback Proxy Rewriter`  [INFERRED] [semantically similar]
  server/server.js → src/routes/resolve.js
- `Render Web Service` --references--> `Express Application`  [EXTRACTED]
  render.yaml → src/index.js
- `Docker Render Deployment` --rationale_for--> `Playwright Browser Extractor`  [EXTRACTED]
  RENDER_DEPLOY.md → src/workers/playwright.js
- `resolveVideasySource()` --calls--> `detectType()`  [INFERRED]
  server/providers.js → src/interceptors/index.js
- `Persistent Cache Store` --shares_data_with--> `Memory Cache Adapter`  [INFERRED]
  src/store/results.js → server/cache.js

## Hyperedges (group relationships)
- **Playback Resolution Flow** — nova-player_nova_browser_player, nova_tmdb_nova_routes, resolve_stream_resolver, playwright_browser_extractor, interceptSetup_playwright_interceptors, proxy_playback_proxy_route [INFERRED 0.86]
- **Provider Direct Resolver Family** — resolve_direct_provider_resolvers, providers_videasy_provider_resolver, playwright_videasy_browser_helpers, interceptors_stream_detection [INFERRED 0.82]
- **Shared Cache Pattern** — results_persistent_cache_store, cache_memory_cache_adapter, server_videasy_api_router, nova_tmdb_nova_routes, resolve_stream_resolver, extract_extraction_job_route [INFERRED 0.84]

## Communities (21 total, 0 thin omitted)

### Community 0 - "Playwright Browser Automation"
Cohesion: 0.06
Nodes (63): buildCookieHeader(), buildVideasyQualityEntries(), buildVidfunQualityEntries(), clearBrowserState(), clickFirstVisible(), clickVideasyQuality(), clickVidfunQuality(), closeCachedBrowser() (+55 more)

### Community 1 - "Proxy Playlist Rewriting"
Cohesion: 0.08
Nodes (28): buildDirectEmbeddedHostUrl(), buildProxyUrl(), filterForwardHeaders(), findFmp4BoxOffset(), findTsSyncOffset(), getEmbeddedHeadersParam(), getEmbeddedHostParam(), getFailureCacheKey() (+20 more)

### Community 2 - "Express Runtime Routes"
Cohesion: 0.11
Nodes (30): Docker Render Deployment, Runtime Bootstrap, Memory Cache Adapter, HLS Download Route, Extraction Job Route, Express Application, Videasy Demo UI, Playwright Interceptors (+22 more)

### Community 3 - "Stream Detection Utilities"
Cohesion: 0.14
Nodes (27): collectJsonStringValues(), createDetectorState(), detectType(), extractStreamFromPayload(), extractUrlLikeTokens(), getStreamCandidateRank(), hasValidEmbeddedHeaders(), isNonStreamAssetUrl() (+19 more)

### Community 4 - "NOVA Catalog Routes"
Cohesion: 0.09
Nodes (16): enqueueExtraction(), tmdbFetch(), withTimeout(), buildVideasyPlaybackUrl(), createMemoryCache(), getVideasyCacheKey(), buildProxyUrl(), getProxyBaseUrl() (+8 more)

### Community 5 - "Resolve Queue Playback URLs"
Cohesion: 0.11
Nodes (19): buildProxyPlaybackUrl(), buildVidnestApiCandidates(), decodeVidnestPayload(), enqueueResolveJob(), getAudioCodecCompatibilityRank(), getCodecCompatibilityRank(), getCodecTokens(), getPrimaryVideoCodec() (+11 more)

### Community 6 - "Provider Fetch Utilities"
Cohesion: 0.15
Nodes (25): buildHeaders(), buildMetadataUrl(), buildPlaybackUrl(), buildProviderUrl(), buildQualityList(), decodePayload(), fetchJsonWithTimeout(), fetchTextWithTimeout() (+17 more)

### Community 7 - "Resolved Stream Caching"
Cohesion: 0.25
Nodes (16): applyPreferredPrimaryPlaybackUrl(), getCachedResolvedStream(), getProviderKeyFromUrl(), getResolveCacheTtl(), isLikelyHlsSegmentCandidate(), isVidcoreUrl(), isVideasyUrl(), isVidfastUrl() (+8 more)

### Community 8 - "NOVA Browser Player UI"
Cohesion: 0.31
Nodes (11): attachStream(), bootstrap(), destroyHls(), fetchJson(), openDrawer(), renderBackdrop(), renderHeader(), renderMeta() (+3 more)

### Community 9 - "Videasy Proxy Fetch"
Cohesion: 0.29
Nodes (10): directRequest(), fetchVideasyThroughProxy(), getVideasyProxyUrl(), getVideasyProxyUrls(), normalizeHeaders(), openProxyTunnel(), proxyHttpsRequest(), shouldUseVideasyProxy() (+2 more)

### Community 10 - "Embedded Header Normalization"
Cohesion: 0.17
Nodes (13): canonicalizePlaybackTarget(), getPlaybackHostParam(), getVideasyPlaybackHeaders(), getVidfastHeaders(), hasMalformedEmbeddedPlaybackHeaders(), isStormProxyPlaybackUrl(), isVidplusPlaybackUrl(), normalizeEmbeddedHeaderParam() (+5 more)

### Community 11 - "Playlist Quality Extraction"
Cohesion: 0.18
Nodes (13): attachQualities(), buildAbsolutePlaylistUrl(), buildFallbackMasterPlaylistUrls(), buildQualityEntriesFromSources(), buildVidrockQualityEntries(), dedupeQualities(), deriveQualityLabelFromVariant(), extractFirstMediaPlaylistEntry() (+5 more)

### Community 12 - "Vidzee Stream Probing"
Cohesion: 0.21
Nodes (13): decryptVidzeeStreamLink(), fetchBinaryProbe(), fetchTextBody(), getVidzeeApiKey(), hasKnownFmp4Box(), hasKnownImageSignature(), hasTsSyncByte(), parseVidzeeEmbedUrl() (+5 more)

### Community 13 - "Videasy Resolver Logic"
Cohesion: 0.2
Nodes (12): buildVideasyApiCandidates(), buildVideasyResolveParams(), createStatusError(), fetchVideasyUrl(), getVideasyMetadataUrl(), hasErrorCode(), isCloudflareBlockPage(), isUsableResolvedPlayback() (+4 more)

### Community 14 - "Subtitle Normalization"
Cohesion: 0.27
Nodes (3): normalizeLanguageCode(), normalizeLanguageLabel(), normalizeSubtitleItem()

### Community 15 - "Vidrock Resolver Logic"
Cohesion: 0.29
Nodes (7): buildVidrockSourceUrl(), buildVidrockToken(), extractVidrockSources(), getVidrockHeaders(), parseVidrockSourceUrl(), resolveVidrockCanonicalDetails(), tryResolveVidrockDirect()

### Community 16 - "CORS Server Bootstrap"
Cohesion: 0.5
Nodes (3): isCorsOriginAllowed(), isLocalDevOrigin(), warmBrowser()

### Community 17 - "Demo Player UI"
Cohesion: 0.83
Nodes (3): buildQuery(), loadStream(), setStatus()

## Knowledge Gaps
- **7 isolated node(s):** `Memory Cache Adapter`, `Runtime Bootstrap`, `Videasy Proxy Fetch`, `SSE Result Stream`, `IntroDB Route` (+2 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `detectType()` connect `Stream Detection Utilities` to `Playwright Browser Automation`, `Resolve Queue Playback URLs`, `Provider Fetch Utilities`, `Playlist Quality Extraction`, `Videasy Resolver Logic`, `Vidrock Resolver Logic`?**
  _High betweenness centrality (0.088) - this node is a cross-community bridge._
- **Why does `extractVideoUrls()` connect `Playwright Browser Automation` to `Stream Detection Utilities`, `NOVA Catalog Routes`, `Resolve Queue Playback URLs`, `Provider Fetch Utilities`?**
  _High betweenness centrality (0.082) - this node is a cross-community bridge._
- **Why does `createCacheStore()` connect `NOVA Catalog Routes` to `Resolve Queue Playback URLs`?**
  _High betweenness centrality (0.041) - this node is a cross-community bridge._
- **Are the 4 inferred relationships involving `resolveVideasySource()` (e.g. with `getVideasySession()` and `decryptVideasyPayload()`) actually correct?**
  _`resolveVideasySource()` has 4 INFERRED edges - model-reasoned connections that need verification._
- **Are the 4 inferred relationships involving `tryResolveVideasyDirect()` (e.g. with `getVideasySession()` and `decryptVideasyPayload()`) actually correct?**
  _`tryResolveVideasyDirect()` has 4 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Memory Cache Adapter`, `Runtime Bootstrap`, `Videasy Proxy Fetch` to the rest of the system?**
  _7 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Playwright Browser Automation` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._