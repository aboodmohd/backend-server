from flask import Flask, request, jsonify, Response
import requests
import re
from flask_cors import CORS
from playwright.sync_api import sync_playwright
import requests.packages.urllib3
import io
import json
import uuid
import zipfile
from urllib.parse import urlencode, urljoin, quote
requests.packages.urllib3.disable_warnings()

app = Flask(__name__)
CORS(app)

@app.route('/')
def home():
    return "🚀 NOVA Backend is Running!"


SUBDL_API_KEY = "EuWRVpLf2Iyd-52MZ3n9Iyi_TX4yxL4-"
SUBSOURCE_API_KEY = "sk_2da97448424b9e7c94fbc9756291c5eac67711df44b978f43fc7ba541163a77a"
SUBTITLE_CACHE = {}
STREAM_HINT_KEYWORDS = [
    '.m3u8', '.mp4', '.m4v', '.ts', 'playlist', 'master', 'manifest',
    'worker', 'skylark', 'storm', 'vhls', 'vidfast', 'vidrock',
    '111movies', 'skyember', 'videostr.net', 'master.json', 'cf-master',
    'hls', '/v4/tab/'
]
STRICT_MEDIA_PATTERNS = [
    '.m3u8', '.mp4', '.m4v', '.ts', '/playlist/', 'playlist/', 'master', 'manifest',
    'master.json', 'cf-master', '/stream2/', '/vod/', '/file2/', '/proxy/file2/',
    'workers.dev/', 'videostr.net', 'vhls', '/v4/tab/', 'index.m3u8'
]


def short_url(url, limit=90):
    if not url:
        return 'None'
    return url if len(url) <= limit else f"{url[:limit]}..."


def detect_provider(url):
    lowered = (url or '').lower()
    for provider in ['vidfast', 'vidrock', '111movies', 'vidnest']:
        if provider in lowered:
            return provider
    return 'generic'


def log_provider(provider, message):
    print(f"🔎 [{provider}] {message}")


def is_challenge_page(html, current_url=''):
    content = ((html or '') + ' ' + (current_url or '')).lower()
    checks = [
        'checking your browser', 'verify you are human', 'just a moment',
        'cf-browser-verification', 'cf-challenge', 'cloudflare', '/cdn-cgi/challenge-platform/'
    ]
    return any(token in content for token in checks)


def should_skip_candidate(candidate_url, page_url=''):
    lowered = (candidate_url or '').lower()
    page_lowered = (page_url or '').lower()

    blocked_parts = [
        '/cdn-cgi/', 'cf.errors.css', 'browser-bar.png', 'cf-no-screenshot-error.png',
        '/assets/', '.css', '.js', 'hls.min.js', '/rum?', '.woff', '.woff2',
        'google-analytics.com/', 'umami.', '/api/send', 'demo-video.mp4'
    ]
    if any(part in lowered for part in blocked_parts):
        return True

    if lowered == page_lowered or lowered.rstrip('/') == page_lowered.rstrip('/'):
        return True

    return False


def stream_priority(candidate_url):
    lowered = (candidate_url or '').lower()
    score = 0

    if 'playlist' in lowered or '.m3u8' in lowered or 'manifest' in lowered:
        score += 100
    if '/playlist/' in lowered or 'hls2.vdrk.site/' in lowered or '.vdrk.site/' in lowered:
        score += 120
    if '/file2/' in lowered or '/proxy/file2/' in lowered:
        score += 95
    if 'workers.dev/' in lowered:
        score += 45
    if 'master' in lowered:
        score += 90
    if '.mp4' in lowered:
        score += 70
    if '.ts' in lowered:
        score += 40
    if 'demo-video' in lowered:
        score -= 500
    if any(part in lowered for part in ['/cdn-cgi/', '.css', '.js', '/assets/']):
        score -= 200

    return score


def looks_like_stream_url(url):
    if not url:
        return False
    lowered = url.lower()
    return any(token in lowered for token in STRICT_MEDIA_PATTERNS)


def is_playlist_response(url, content_type='', body=''):
    lowered_type = (content_type or '').lower()
    body_start = (body or '')[:512].lstrip()
    return (
        '.m3u8' in (url or '').lower()
        or 'mpegurl' in lowered_type
        or 'application/x-mpegurl' in lowered_type
        or 'vnd.apple.mpegurl' in lowered_type
        or body_start.startswith('#EXTM3U')
        or '#EXTINF' in body_start
        or '#EXT-X-STREAM-INF' in body_start
    )


def build_proxy_url(host, target_url, referer='', cookie=''):
    lowered = (target_url or '').lower()
    proxy_name = 'stream.bin'
    if is_playlist_response(target_url):
        proxy_name = 'manifest.m3u8'
    elif any(token in lowered for token in ['cf-master', '/v4/tab/', 'playlist', 'master', 'm3u8', 'manifest', 'vhls']):
        proxy_name = 'manifest.m3u8'
    elif '.mp4' in lowered or '.m4v' in lowered:
        proxy_name = 'video.mp4'
    elif '.ts' in lowered:
        proxy_name = 'segment.ts'

    forwarded_proto = request.headers.get('X-Forwarded-Proto', request.scheme or 'http')
    proxy_url = f"{forwarded_proto}://{host}/proxy/{proxy_name}?url={quote(target_url, safe='')}"
    if referer:
        proxy_url += f"&referer={quote(referer, safe='')}"
    if cookie:
        proxy_url += f"&cookie={quote(cookie, safe='')}"
    return proxy_url


def rewrite_playlist_content(content, base_url, host, referer='', cookie=''):
    rewritten_lines = []
    uri_pattern = re.compile(r'URI="([^"]+)"')

    for raw_line in content.splitlines():
        line = raw_line.strip()

        if not line:
            rewritten_lines.append(raw_line)
            continue

        if line.startswith('#'):
            def replace_uri(match):
                absolute = urljoin(base_url, match.group(1))
                return f'URI="{build_proxy_url(host, absolute, referer, cookie)}"'

            rewritten_lines.append(uri_pattern.sub(replace_uri, raw_line))
            continue

        absolute = urljoin(base_url, line)
        rewritten_lines.append(build_proxy_url(host, absolute, referer, cookie))

    return '\n'.join(rewritten_lines)


def extract_stream_url_from_json_payload(payload, base_url=''):
    candidates = []

    def visit(value):
        if isinstance(value, str):
            normalized = value.strip()
            if normalized.startswith('http://') or normalized.startswith('https://'):
                candidates.append(normalized)
            elif normalized.startswith('/') and base_url:
                candidates.append(urljoin(base_url, normalized))
        elif isinstance(value, dict):
            for nested in value.values():
                visit(nested)
        elif isinstance(value, list):
            for nested in value:
                visit(nested)

    visit(payload)
    prioritized = sorted(candidates, key=stream_priority, reverse=True)
    return next((candidate for candidate in prioritized if looks_like_stream_url(candidate)), None)


def probe_stream_candidate(url, headers):
    if not url:
        return False

    provider = detect_provider(url)

    probe_headers = {
        'User-Agent': headers.get('User-Agent') or headers.get('user-agent') or 'Mozilla/5.0',
        'Referer': headers.get('Referer') or headers.get('referer') or '',
        'Accept': '*/*',
        'Connection': 'keep-alive',
    }
    cookie = headers.get('Cookie') or headers.get('cookie')
    if cookie:
        probe_headers['Cookie'] = cookie

    try:
        response = requests.get(url, headers=probe_headers, stream=True, timeout=12, verify=False)
        response.raise_for_status()
        content_type = response.headers.get('Content-Type', '')
        preview = ''
        try:
            preview = response.raw.read(512, decode_content=True).decode('utf-8', errors='ignore')
        except Exception:
            preview = ''
        finally:
            response.close()

        if is_playlist_response(url, content_type, preview):
            log_provider(provider, f"probe accepted playlist content-type={content_type or 'unknown'} url={short_url(url)}")
            return True

        lowered_type = content_type.lower()
        if 'application/json' in lowered_type:
            body = preview
            try:
                if not body or not body.strip().startswith(('{', '[')):
                    refill = requests.get(url, headers=probe_headers, timeout=12, verify=False)
                    refill.raise_for_status()
                    body = refill.text
                payload = json.loads(body)
                embedded_url = extract_stream_url_from_json_payload(payload, url)
                if embedded_url:
                    log_provider(provider, f"probe accepted json-embedded url={short_url(embedded_url)} source={short_url(url)}")
                    return True
            except Exception:
                pass

        accepted = lowered_type.startswith('video/') or 'octet-stream' in lowered_type
        log_provider(provider, f"probe {'accepted' if accepted else 'rejected'} content-type={content_type or 'unknown'} url={short_url(url)}")
        return accepted
    except Exception as exc:
        print(f"⚠️ Probe failed for stream candidate {url[:80]}...: {exc}")
        log_provider(provider, f"probe fallback heuristic={looks_like_stream_url(url)} url={short_url(url)}")
        return looks_like_stream_url(url)


def extract_subtitle_file(archive_bytes):
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        subtitle_names = [
            name for name in archive.namelist()
            if name.lower().endswith((".srt", ".vtt")) and not name.endswith("/")
        ]

        if not subtitle_names:
            return None, None

        preferred_name = sorted(
            subtitle_names,
            key=lambda name: (0 if name.lower().endswith(".vtt") else 1, len(name))
        )[0]
        raw_bytes = archive.read(preferred_name)

        for encoding in ("utf-8-sig", "utf-8", "cp1256", "latin-1"):
            try:
                return raw_bytes.decode(encoding), preferred_name
            except UnicodeDecodeError:
                continue

        return raw_bytes.decode("utf-8", errors="ignore"), preferred_name


def cache_subtitle_content(content, filename):
    token = uuid.uuid4().hex
    extension = filename.rsplit('.', 1)[-1].lower() if '.' in filename else 'srt'
    SUBTITLE_CACHE[token] = {
        "content": content,
        "mime": "text/vtt" if extension == "vtt" else "application/x-subrip",
    }
    return token, extension


def normalize_subsource_language(language):
    mapping = {
        'EN': 'english',
        'AR': 'arabic',
        'ENGLISH': 'english',
        'ARABIC': 'arabic',
    }
    return mapping.get((language or '').strip().upper())


def normalize_language_code(language_name):
    lowered = (language_name or '').strip().lower()
    if lowered == 'english':
        return 'EN'
    if lowered == 'arabic':
        return 'AR'
    return (language_name or 'UN')[:2].upper()


def infer_subtitle_language_from_url(url):
    lowered = (url or '').lower()
    if any(token in lowered for token in ['arabic', '/ar/', '_ar', '-ar', '.ar.', 'lang=ar']):
        return 'Arabic', 'AR'
    if any(token in lowered for token in ['english', '/en/', '_en', '-en', '.en.', 'lang=en']):
        return 'English', 'EN'
    return 'Default', 'UN'


def infer_subtitle_language_from_label(label, fallback_url=''):
    lowered = (label or '').strip().lower()
    if any(token in lowered for token in ['arabic', ' arabic', ' ar', '[ar]', '(ar)', 'ara']):
        return 'Arabic', 'AR'
    if any(token in lowered for token in ['english', ' eng', ' en', '[en]', '(en)']):
        return 'English', 'EN'
    return infer_subtitle_language_from_url(fallback_url)


def looks_like_subtitle_url(url):
    lowered = (url or '').lower()
    return any(token in lowered for token in ['.vtt', '.srt', '.ass', '.ssa', 'subtitle', '/sub/', 'captions', 'texttrack'])


def extract_subtitle_candidates_from_json_payload(payload):
    candidates = []

    def visit(value, context_label=''):
        if isinstance(value, dict):
            url_value = None
            for key in ['file', 'src', 'url', 'track', 'subtitle', 'subtitleUrl']:
                candidate = value.get(key)
                if isinstance(candidate, str) and candidate.startswith(('http://', 'https://')) and looks_like_subtitle_url(candidate):
                    url_value = candidate
                    break

            if url_value:
                label = value.get('label') or value.get('language') or value.get('lang') or context_label
                candidates.append((url_value, label or ''))

            for key, nested in value.items():
                next_label = context_label
                if key.lower() in ['label', 'language', 'lang', 'name'] and isinstance(nested, str):
                    next_label = nested
                visit(nested, next_label)
        elif isinstance(value, list):
            for nested in value:
                visit(nested, context_label)

    visit(payload)
    return candidates


def fetch_subtitles_from_subsource(tmdb_id, media_type, title=None, season=None, episode=None, languages="EN,AR", limit=6):
    if not SUBSOURCE_API_KEY or not title:
        return []

    headers = {
        'X-API-Key': SUBSOURCE_API_KEY,
        'Accept': 'application/json',
    }
    media_kind = 'series' if media_type == 'tv' else 'movie'
    search_params = {
        'searchType': 'text',
        'q': title,
        'type': media_kind,
    }
    if media_type == 'tv' and season is not None:
        search_params['season'] = season

    search_response = requests.get(
        'https://api.subsource.net/api/v1/movies/search',
        headers=headers,
        params=search_params,
        timeout=20,
    )
    search_response.raise_for_status()
    search_payload = search_response.json()
    search_results = search_payload.get('data') or []

    matched = next(
        (
            item for item in search_results
            if str(item.get('tmdbId') or '') == str(tmdb_id)
            and (item.get('type') == media_kind or media_type == 'tv')
            and (media_type != 'tv' or str(item.get('season') or season or '') == str(season or ''))
        ),
        None,
    )

    if not matched and search_results:
        matched = search_results[0]

    movie_id = matched.get('movieId') if matched else None
    if not movie_id:
        return []

    collected = []
    seen = set()
    for language in [normalize_subsource_language(item) for item in languages.split(',')]:
        if not language:
            continue

        subtitle_response = requests.get(
            'https://api.subsource.net/api/v1/subtitles',
            headers=headers,
            params={
                'movieId': movie_id,
                'language': language,
                'limit': limit,
            },
            timeout=20,
        )
        subtitle_response.raise_for_status()
        subtitle_payload = subtitle_response.json()

        for item in subtitle_payload.get('data') or []:
            subtitle_id = item.get('subtitleId')
            if not subtitle_id:
                continue

            release_info = item.get('releaseInfo') or []
            release_name = release_info[0] if release_info else f"SubSource {subtitle_id}"
            dedupe_key = (language, release_name)
            if dedupe_key in seen:
                continue

            try:
                download_response = requests.get(
                    f'https://api.subsource.net/api/v1/subtitles/{subtitle_id}/download',
                    headers=headers,
                    timeout=25,
                )
                download_response.raise_for_status()
                content, filename = extract_subtitle_file(download_response.content)
                if not content or not filename:
                    continue

                token, extension = cache_subtitle_content(content, filename)
                seen.add(dedupe_key)
                collected.append({
                    'language': language.title(),
                    'languageCode': normalize_language_code(language),
                    'releaseName': release_name,
                    'url': f"{request.host_url.rstrip('/')}/subtitle/{token}",
                    'format': extension,
                    'provider': 'subsource',
                    'season': season,
                    'episode': episode,
                })
            except Exception as exc:
                print(f"⚠️ SubSource download failed for {subtitle_id}: {exc}")

            if len(collected) >= limit:
                return collected

    return collected


def fetch_subtitles_from_subdl(tmdb_id, media_type, season=None, episode=None, languages="EN,AR", limit=6):
    params = {
        "api_key": SUBDL_API_KEY,
        "tmdb_id": tmdb_id,
        "type": media_type,
        "languages": languages,
        "subs_per_page": min(limit, 30),
    }

    if media_type == 'tv':
        if season is not None:
            params["season_number"] = season
        if episode is not None:
            params["episode_number"] = episode

    response = requests.get(
        f"https://api.subdl.com/api/v1/subtitles?{urlencode(params)}",
        headers={"Accept": "application/json"},
        timeout=20,
    )
    response.raise_for_status()
    payload = response.json()

    if not payload.get('status'):
        return []

    results = []
    for item in payload.get('subtitles', []):
        relative_url = item.get('url')
        if not relative_url:
            continue

        try:
            download_url = urljoin('https://dl.subdl.com', relative_url)
            archive_response = requests.get(download_url, timeout=20)
            archive_response.raise_for_status()

            content, filename = extract_subtitle_file(archive_response.content)
            if not content or not filename:
                continue

            token, extension = cache_subtitle_content(content, filename)
            results.append({
                "language": item.get('lang') or item.get('language') or 'Unknown',
                "languageCode": item.get('language') or 'UN',
                "releaseName": item.get('release_name') or item.get('name') or filename,
                "url": f"{request.host_url.rstrip('/')}/subtitle/{token}",
                "format": extension,
                "provider": 'subdl',
            })
        except Exception as exc:
            print(f"⚠️ Subtitle fetch failed for {relative_url}: {exc}")

        if len(results) >= limit:
            break

    return results

def extract_stream_with_playwright(url, preferred_quality='Auto'):
    print(f"📡 Omni-Extraction Mode: {url} (Quality: {preferred_quality})")
    provider = detect_provider(url)
    log_provider(provider, f"starting extraction quality={preferred_quality}")
    
    BLOCK_DOMAINS = ["adscore", "dtscout", "doubleclick", "analytics", "clarity", "histats", "onclick", "popunder", "exoclick", "juicyads", "popcash", "jads.co"]
    SUCCESS_KEYWORDS = STREAM_HINT_KEYWORDS

    def is_url_video(u):
        if not u: return False
        return looks_like_stream_url(u)

    def is_high_priority_stream(u):
        lowered = (u or '').lower()
        return any(token in lowered for token in ['.m3u8', 'playlist', 'master', 'manifest', '/file2/', '/stream2/'])

    def try_extraction(is_mobile=False):
        local_streams = []
        local_subtitles = []
        local_winner = {"url": None, "headers": {}}

        def remember_subtitle(candidate_url, label=''):
            if not candidate_url or not looks_like_subtitle_url(candidate_url):
                return
            if any(s['url'] == candidate_url for s in local_subtitles):
                return

            language_name, language_code = infer_subtitle_language_from_label(label, candidate_url)
            print(f"🗨️ Captured Subtitle: {candidate_url[:40]}...")
            local_subtitles.append({
                "url": candidate_url,
                "language": language_name,
                "languageCode": language_code,
                "provider": "embed",
                "label": label or language_name,
            })

        def remember_stream(candidate_url, headers=None, force_winner=False):
            if not candidate_url:
                return
            if should_skip_candidate(candidate_url, url):
                return

            candidate = {"url": candidate_url, "headers": headers or {}}
            is_new = not any(existing['url'] == candidate_url for existing in local_streams)
            if is_new:
                local_streams.append(candidate)
                source_referer = candidate['headers'].get('Referer') or candidate['headers'].get('referer') or 'n/a'
                log_provider(provider, f"captured candidate url={short_url(candidate_url)} referer={short_url(source_referer, 60)}")

            current_winner_score = stream_priority(local_winner.get('url'))
            candidate_score = stream_priority(candidate_url)
            should_promote = force_winner or (preferred_quality != 'Auto' and preferred_quality.replace('p', '') in candidate_url)

            if should_promote and candidate_score >= current_winner_score:
                local_winner.update(candidate)
                log_provider(provider, f"promoted winner url={short_url(candidate_url)} force={force_winner}")

            return is_high_priority_stream(candidate_url)
        
        try:
            with sync_playwright() as p:
                ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                if is_mobile: 
                    ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
                
                # Performance Tip: minimal browser setup for 2017 MacBook
                browser = p.chromium.launch(
                    headless=True,
                    args=[
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-blink-features=AutomationControlled',
                        '--disable-dev-shm-usage',
                        '--disable-features=IsolateOrigins,site-per-process',
                        '--disable-web-security',
                    ]
                )
                
                context_args = {
                    "user_agent": ua,
                    "viewport": {'width': 390, 'height': 844} if is_mobile else {'width': 1280, 'height': 720},
                    "has_touch": is_mobile,
                    "is_mobile": is_mobile,
                    "ignore_https_errors": True,
                    "locale": "en-US",
                    "timezone_id": "America/New_York",
                    "extra_http_headers": {
                        "Accept-Language": "en-US,en;q=0.9",
                        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
                        "sec-ch-ua-mobile": "?1" if is_mobile else "?0",
                        "sec-ch-ua-platform": '"iOS"' if is_mobile else '"Windows"',
                        "Upgrade-Insecure-Requests": "1"
                    }
                }
                context = browser.new_context(**context_args)
                context.add_init_script("""
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
                    Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
                    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
                    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
                    window.chrome = window.chrome || { runtime: {} };
                """)
                context.route(
                    "**/*",
                    lambda route: route.abort()
                    if route.request.resource_type in ["media"]
                    or any(domain in route.request.url.lower() for domain in BLOCK_DOMAINS)
                    else route.continue_()
                )
                page = context.new_page()

                def handle_request(req):
                    r_url = req.url
                    # Record subtitles (VTT/SRT)
                    if any(x in r_url.lower() for x in ['.vtt', '.srt', 'subtitle', '/sub/']):
                        remember_subtitle(r_url)

                    if any(kw in r_url.lower() for kw in SUCCESS_KEYWORDS):
                        if is_url_video(r_url):
                            if remember_stream(r_url, dict(req.headers)):
                                page.evaluate("window.stop && window.stop()")

                def handle_response(response):
                    try:
                        r_url = response.url
                        content_type = (response.headers or {}).get('content-type', '')
                        lowered_type = content_type.lower()

                        if 'text/vtt' in lowered_type or 'subrip' in lowered_type or looks_like_subtitle_url(r_url):
                            remember_subtitle(r_url)

                        if 'application/json' in lowered_type and any(token in r_url.lower() for token in ['subtitle', 'track', 'caption', 'player', 'source']):
                            try:
                                payload = response.json()
                                for subtitle_url, label in extract_subtitle_candidates_from_json_payload(payload):
                                    remember_subtitle(subtitle_url, label)
                            except Exception:
                                pass

                        if is_playlist_response(r_url, content_type) or content_type.lower().startswith('video/'):
                            headers = dict(response.request.headers)
                            headers['Accept'] = headers.get('Accept', '*/*')
                            if remember_stream(r_url, headers, force_winner=is_playlist_response(r_url, content_type)):
                                page.evaluate("window.stop && window.stop()")
                    except Exception:
                        pass

                page.on("request", handle_request)
                page.on("response", handle_response)

                def interact():
                    selectors = ["button", ".play-button", "video", ".v-la11", "iframe", "[aria-label*='Play' i]", "main", "canvas"]
                    for frame in page.frames:
                        try:
                            for s in selectors: frame.evaluate(f"document.querySelector('{s}')?.click()")
                        except: pass
                    try: page.mouse.click(640, 360)
                    except: pass

                def wait_for_challenge_clear(label):
                    try:
                        for attempt in range(1, 13):
                            html = page.content()
                            current_page_url = page.url
                            if not is_challenge_page(html, current_page_url):
                                if attempt > 1:
                                    log_provider(provider, f"challenge cleared mode={label} attempts={attempt} url={short_url(current_page_url)}")
                                return

                            if attempt == 1:
                                print(f"🛡️ Solving Challenge ({'Mobile' if is_mobile else 'Desktop'})...")
                                log_provider(provider, f"challenge detected mode={label} url={short_url(current_page_url)}")

                            interact()
                            try:
                                page.mouse.move(320, 240)
                                page.mouse.wheel(0, 400)
                            except Exception:
                                pass
                            page.wait_for_timeout(500)

                        log_provider(provider, f"challenge persisted mode={label} final_url={short_url(page.url)}")
                    except Exception as exc:
                        log_provider(provider, f"challenge wait error mode={label} error={exc}")

                try:
                    # Clear session for 111Movies
                    if '111movies' in url:
                        page.goto('https://111movies.net', wait_until='domcontentloaded', timeout=8000); page.wait_for_timeout(500)
                        wait_for_challenge_clear('warmup')
                    
                    # 15s Timeout as per Ultimate Fix Blueprint
                    page.goto(url, wait_until='domcontentloaded', timeout=12000)
                    page.wait_for_timeout(500)
                    wait_for_challenge_clear('target')
                except: pass

                def scan_dom_for_sources():
                    try:
                        discovered = page.evaluate("""
                            () => {
                                const found = [];
                                const attrs = ['src', 'href', 'data-src', 'data-url'];
                                for (const el of document.querySelectorAll('video, source, iframe, a, [src], [href], [data-src], [data-url]')) {
                                    for (const attr of attrs) {
                                        const value = el.getAttribute(attr);
                                        if (value && /^https?:/i.test(value)) {
                                            found.push({ url: value, label: el.getAttribute('label') || el.getAttribute('srclang') || el.getAttribute('lang') || '' });
                                        }
                                    }
                                }
                                for (const el of document.querySelectorAll('track[kind="subtitles"], track[kind="captions"], [data-subtitle], [data-track]')) {
                                    const value = el.getAttribute('src') || el.getAttribute('data-subtitle') || el.getAttribute('data-track') || el.getAttribute('data-src');
                                    if (value && /^https?:/i.test(value)) {
                                        found.push({ url: value, label: el.getAttribute('label') || el.getAttribute('srclang') || el.getAttribute('lang') || '' });
                                    }
                                }
                                const configs = [];
                                for (const key of Object.keys(window)) {
                                    try {
                                        const value = window[key];
                                        if (value && typeof value === 'object') configs.push(value);
                                    } catch (e) {}
                                }
                                const html = document.documentElement?.outerHTML || '';
                                const matches = html.match(/https?:\\/\\/[^\"'\\s<>()]+/g) || [];
                                for (const item of matches) found.push({ url: item, label: '' });
                                return found;
                            }
                        """)
                        for item in discovered:
                            candidate_url = item.get('url') if isinstance(item, dict) else item
                            label = item.get('label', '') if isinstance(item, dict) else ''
                            if looks_like_subtitle_url(candidate_url):
                                remember_subtitle(candidate_url, label)
                            elif looks_like_stream_url(candidate_url):
                                remember_stream(candidate_url, {"Referer": url})
                    except Exception:
                        pass

                interact(); page.wait_for_timeout(500)
                scan_dom_for_sources()

                if is_url_video(local_winner["url"]):
                    cookies = context.cookies()
                    cookie_str = "; ".join([f"{c['name']}={c['value']}" for c in cookies])
                    browser.close()
                    local_winner["headers"]["Cookie"] = cookie_str
                    local_winner["subtitles"] = local_subtitles
                    return local_winner
                
                # Check discovery loop
                for _ in range(6):
                    if is_url_video(local_winner["url"]): break
                    page.wait_for_timeout(500)
                    if not local_streams:
                        interact()
                    scan_dom_for_sources()

                if not local_streams:
                    m3u8_match = re.search(r'(https?://[^"\']+(?:m3u8|mp4|json|txt|playlist|master|manifest)[^"\']*)', page.content())
                    if m3u8_match and is_url_video(m3u8_match.group(1)):
                        remember_stream(m3u8_match.group(1), {"Referer": url}, force_winner=True)

                cookies = context.cookies()
                cookie_str = "; ".join([f"{c['name']}={c['value']}" for c in cookies])
                browser.close()

                result = None
                if is_url_video(local_winner["url"]):
                    print(f"✅ Success: Captured Quality ({local_winner['url'][:40]}...)")
                    local_winner["headers"]["Cookie"] = cookie_str
                    result = local_winner
                else:
                    valid_streams = [s for s in local_streams if is_url_video(s['url'])]
                    if valid_streams:
                        result = max(valid_streams, key=lambda stream: stream_priority(stream['url']))
                        print(f"✅ Success: Captured Valid Stream ({result['url'][:40]}...)")
                        result["headers"]["Cookie"] = cookie_str

                if result:
                    log_provider(provider, f"returning stream url={short_url(result['url'])} subtitles={len(local_subtitles)} candidates={len(local_streams)}")
                    result["subtitles"] = local_subtitles
                    return result
                log_provider(provider, f"no playable stream found subtitles={len(local_subtitles)} candidates={len(local_streams)}")
                    
        except Exception as e:
            print(f"❌ Playwright Error ({'Mobile' if is_mobile else 'Desktop'}): {e}")
            log_provider(provider, f"playwright exception mode={'mobile' if is_mobile else 'desktop'} error={e}")
        return None

    log_provider(provider, "launching desktop worker")
    desktop_result = try_extraction(is_mobile=False)
    if desktop_result and desktop_result.get('url'):
        desktop_result["success"] = True
        log_provider(provider, f"worker Desktop WON with url={short_url(desktop_result['url'])}")
        return desktop_result

    log_provider(provider, "desktop worker failed, launching mobile worker")
    mobile_result = try_extraction(is_mobile=True)
    if mobile_result and mobile_result.get('url'):
        mobile_result["success"] = True
        log_provider(provider, f"worker Mobile WON with url={short_url(mobile_result['url'])}")
        return mobile_result

    log_provider(provider, "both workers finished without a direct stream")
    return {"url": None, "headers": {}, "success": False, "subtitles": []}

@app.route('/proxy')
@app.route('/proxy/<path:_name>')
def proxy(_name=None):
    url = request.args.get('url')
    if not url: return "No URL", 400
    provider = detect_provider(request.args.get('referer') or url)
    
    referer = request.args.get('referer', '')
    cookie = request.args.get('cookie', '')
    
    # 1. Build Extractor-Friendly Headers
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': referer,
        'Accept': '*/*',
        'Connection': 'keep-alive'
    }
    if cookie: headers['Cookie'] = cookie
    
    range_header = request.headers.get('Range', None)
    if range_header: headers['Range'] = range_header

    try:
        # 2. Fetch the stream from the provider
        req = requests.get(url, headers=headers, stream=True, timeout=20, verify=False)
        req.raise_for_status()
        
        # 3. Force Correct MIME Type (Fixes a8.W error)
        content_type = req.headers.get('Content-Type', '')
        if is_playlist_response(url, content_type):
            content_type = 'application/vnd.apple.mpegurl'
        elif '.mp4' in url.lower():
            content_type = 'video/mp4'
        elif not content_type:
            content_type = 'video/MP2T' # Default for .ts segments

        resp_headers = {
            'Content-Type': content_type,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'Accept-Ranges': 'bytes'
        }
        if 'Content-Range' in req.headers: resp_headers['Content-Range'] = req.headers['Content-Range']
        log_provider(provider, f"proxy fetch status={req.status_code} type={content_type or 'unknown'} url={short_url(url)}")

        if is_playlist_response(url, content_type):
            playlist_body = req.text
            rewritten_playlist = rewrite_playlist_content(playlist_body, url, request.host, referer, cookie)
            log_provider(provider, f"proxy rewrote playlist lines={len(rewritten_playlist.splitlines())} url={short_url(url)}")
            return Response(rewritten_playlist, req.status_code, resp_headers.items())

        if 'application/json' in content_type.lower():
            payload = req.json()
            embedded_url = extract_stream_url_from_json_payload(payload, url)
            if embedded_url:
                log_provider(provider, f"proxy resolved json stream target={short_url(embedded_url)} source={short_url(url)}")
                embedded_response = requests.get(embedded_url, headers=headers, stream=True, timeout=20, verify=False)
                embedded_response.raise_for_status()
                embedded_type = embedded_response.headers.get('Content-Type', '')
                embedded_headers = {
                    'Content-Type': 'application/vnd.apple.mpegurl' if is_playlist_response(embedded_url, embedded_type) else (embedded_type or 'video/MP2T'),
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache',
                    'Accept-Ranges': 'bytes'
                }
                if 'Content-Range' in embedded_response.headers:
                    embedded_headers['Content-Range'] = embedded_response.headers['Content-Range']

                if is_playlist_response(embedded_url, embedded_type):
                    embedded_playlist = embedded_response.text
                    rewritten_playlist = rewrite_playlist_content(embedded_playlist, embedded_url, request.host, referer, cookie)
                    return Response(rewritten_playlist, embedded_response.status_code, embedded_headers.items())

                return Response(embedded_response.iter_content(chunk_size=256*1024), embedded_response.status_code, embedded_headers.items())

        return Response(req.iter_content(chunk_size=256*1024), req.status_code, resp_headers.items())
    except Exception as e:
        print(f"❌ Proxy Fail: {e}")
        log_provider(provider, f"proxy failure error={e} url={short_url(url)}")
        return str(e), 500

@app.route('/resolve', methods=['POST', 'GET'])
def resolve():
    try:
        preferred_quality = 'Auto'
        if request.method == 'POST':
            data = request.json or {}
            url = data.get('url')
            preferred_quality = data.get('quality', 'Auto')
        else:
            url = request.args.get('url')
            preferred_quality = request.args.get('quality', 'Auto')

        if not url:
            return jsonify({"success": False, "error": "No url provided"}), 400

        provider = detect_provider(url)
        log_provider(provider, f"resolve request quality={preferred_quality} url={short_url(url)}")

        print(f"Resolving with Playwright (Quality: {preferred_quality}): {url}")
        extracted = extract_stream_with_playwright(url, preferred_quality)
        
        curr_url = extracted.get('url')
        curr_headers = extracted.get('headers', {})
        
        # STRICT VALIDATION: Ensure we actually found a video file, not an HTML page
        is_valid_video = probe_stream_candidate(curr_url, curr_headers)
        if not is_valid_video:
            print(f"⚠️ Validation Failed: Extracted URL is not a direct video stream.")
            log_provider(provider, f"validation failed extracted={short_url(curr_url)}")
            return jsonify({
                "success": False, 
                "error": "Failed to extract raw video. Bot protection detected."
            }), 400

        # APPLY PROXY TO BYPASS 403s
        prov_keywords = ['workers.dev', 'vidrock', 'vidfast', 'vidnest', 'vhls', 'm3u8-proxy', '111movies']
        should_proxy = any(kw in (curr_url or '').lower() for kw in prov_keywords) or any(kw in url.lower() for kw in prov_keywords)

        if should_proxy:
            print(f"🛠️ Wrapping '{url[:20]}...' in Backend Proxy...")
            referer = curr_headers.get('referer', '') or curr_headers.get('Referer', '') or url
            cookie = curr_headers.get('Cookie', '') or curr_headers.get('cookie', '')
            
            proxy_url = build_proxy_url(request.host, curr_url, referer, cookie)
            log_provider(provider, f"proxying extracted={short_url(curr_url)} proxy={short_url(proxy_url)}")

            return jsonify({
                "success": True,
                "url": proxy_url,
                "headers": curr_headers,
                "subtitles": extracted.get('subtitles', [])
            })

        return jsonify({
            "success": True,
            "url": curr_url,
            "headers": curr_headers,
            "subtitles": extracted.get('subtitles', [])
        })
    except Exception as e:
        print(f"🔥 Critical Resolve Error: {e}")
        log_provider(detect_provider(request.args.get('url') or ''), f"resolve exception error={e}")
        return jsonify({"success": False, "error": f"Internal Server Error: {str(e)}"}), 500


@app.route('/subtitles', methods=['GET'])
def subtitles():
    tmdb_id = request.args.get('tmdbId')
    media_type = request.args.get('type', 'movie')
    season = request.args.get('season')
    episode = request.args.get('episode')
    languages = request.args.get('languages', 'EN,AR')
    title = request.args.get('title')

    if not tmdb_id:
        return jsonify({"success": False, "error": "tmdbId is required", "subtitles": []}), 400

    try:
        subtitle_results = []

        subsource_results = fetch_subtitles_from_subsource(
            tmdb_id=tmdb_id,
            media_type=media_type,
            title=title,
            season=season,
            episode=episode,
            languages=languages,
        )
        subtitle_results.extend(subsource_results)

        subdl_results = fetch_subtitles_from_subdl(
            tmdb_id=tmdb_id,
            media_type=media_type,
            season=season,
            episode=episode,
            languages=languages,
        )
        subtitle_results.extend(subdl_results)

        deduped = []
        seen = set()
        for item in subtitle_results:
            key = (item.get('languageCode'), item.get('releaseName'), item.get('provider'))
            if key in seen:
                continue
            seen.add(key)
            deduped.append(item)

        return jsonify({
            "success": True,
            "provider": 'combined',
            "subsourceConfigured": bool(SUBSOURCE_API_KEY),
            "subtitles": deduped,
        })
    except Exception as exc:
        print(f"❌ Subtitle lookup failed: {exc}")
        return jsonify({"success": False, "error": str(exc), "subtitles": []}), 500


@app.route('/subtitle/<token>', methods=['GET'])
def subtitle_content(token):
    cached = SUBTITLE_CACHE.get(token)
    if not cached:
        return jsonify({"success": False, "error": "Subtitle not found"}), 404

    return Response(cached['content'], mimetype=cached['mime'])

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
