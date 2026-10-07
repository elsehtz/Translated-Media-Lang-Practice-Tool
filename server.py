#!/usr/bin/env python3
"""El Dahih bilingual player: a small local server.

Serves the UI in ./static plus two JSON endpoints:

  GET  /api/registry              every El Dahih episode found on the channels in sources.json
  POST /api/registry/refresh      rebuild that list in the background
  GET  /api/transcript?id=<id>    the episode's Arabic captions with English alongside, row by row

Nothing is fetched until you ask for it. Captions come from YouTube's own caption
tracks at the moment you open an episode, and are cached in ./data on this computer.
"""

import argparse
import bisect
import html
import json
import re
import socket
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = ROOT / "data"
CACHE = DATA / "transcripts"
REGISTRY_FILE = DATA / "registry.json"
SOURCES_FILE = ROOT / "sources.json"
REGISTRY_MAX_AGE = 3 * 24 * 3600  # refresh the episode list in the background every 3 days
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


# --------------------------------------------------------------------------- registry

_AR_DIACRITICS = re.compile(r"[ؐ-ًؚ-ٰٟۖ-ۭـ]")


def title_key(title):
    """Loose key so the same episode uploaded to two channels is listed once."""
    t = _AR_DIACRITICS.sub("", title or "").translate(str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789"))
    t = re.sub(r"[أإآ]", "ا", t).replace("ى", "ي").replace("ة", "ه")
    t = re.sub(r"(الدحيح|el\s*dahih|da7ee7)", "", t, flags=re.I)
    t = re.sub(r"[^\w]+", "", t.lower())
    return t


def iter_channel(url):
    """Yield (channel_name, entry) for every video on a channel/playlist tab, lazily."""
    import yt_dlp

    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "ignoreerrors": True,
        "extractor_args": {"youtubetab": {"approximate_date": [""]}},
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False, process=False)
        if not info:
            raise RuntimeError("YouTube returned nothing for " + url)
        channel = info.get("channel") or info.get("uploader") or info.get("title") or ""
        for entry in info.get("entries") or []:
            if entry:
                yield channel, entry


class Registry:
    def __init__(self):
        self.lock = threading.Lock()
        self.videos = []
        self.updated_at = None
        self.building = False
        self.partial = []
        self.progress = []
        self.errors = []
        self.eras = []
        self._load()

    def _load(self):
        try:
            self.eras = json.loads(SOURCES_FILE.read_text("utf-8")).get("eras", [])
        except Exception:
            self.eras = []
        if REGISTRY_FILE.exists():
            try:
                saved = json.loads(REGISTRY_FILE.read_text("utf-8"))
                self.videos = saved.get("videos", [])
                self.updated_at = saved.get("updated_at")
            except Exception:
                log("registry.json unreadable; it will be rebuilt")

    def stale(self):
        return not self.videos or not self.updated_at or time.time() - self.updated_at > REGISTRY_MAX_AGE

    def snapshot(self):
        with self.lock:
            return {
                "videos": self.videos or self.partial,
                "complete": bool(self.videos),
                "updated_at": self.updated_at,
                "building": self.building,
                "progress": list(self.progress),
                "errors": list(self.errors),
                "eras": self.eras,
            }

    def refresh(self):
        with self.lock:
            if self.building:
                return False
            self.building = True
            self.partial, self.progress, self.errors = [], [], []
        threading.Thread(target=self._build, daemon=True).start()
        return True

    def _build(self):
        try:
            config = json.loads(SOURCES_FILE.read_text("utf-8"))
            eras = {e["key"]: e for e in config.get("eras", [])}
            found, seen_ids, seen_titles = [], set(), set()
            ok_sources = 0

            for s_idx, src in enumerate(config.get("sources", [])):
                need = [w.lower() for w in src.get("title_must_include", [])]
                era = eras.get(src["era"], {"key": src["era"], "order": 0})
                with self.lock:
                    self.progress.append({"source": src.get("name") or src["url"], "count": 0, "done": False})
                    slot = len(self.progress) - 1
                log("listing", src["url"])
                try:
                    for i, (channel, e) in enumerate(iter_channel(src["url"])):
                        vid, title = e.get("id"), (e.get("title") or "").strip()
                        if not vid or not VIDEO_ID.match(vid) or vid in seen_ids:
                            continue
                        if title in ("[Private video]", "[Deleted video]"):
                            continue
                        if need and not any(w in title.lower() for w in need):
                            continue
                        key = title_key(title)
                        if key and key in seen_titles:
                            continue
                        seen_ids.add(vid)
                        if key:
                            seen_titles.add(key)
                        found.append({
                            "id": vid,
                            "title": title,
                            "era": era["key"],
                            "channel": e.get("channel") or channel,
                            "duration": e.get("duration"),
                            "views": e.get("view_count"),
                            "ts": e.get("timestamp"),
                            "_sort": (era.get("order", 0), s_idx, i),
                        })
                        with self.lock:
                            self.progress[slot]["count"] += 1
                            if len(found) % 25 == 0:
                                self.partial = _ordered(found)
                    ok_sources += 1
                except Exception as exc:  # keep going with the other channels
                    log("  failed:", exc)
                    with self.lock:
                        self.errors.append({"source": src.get("name") or src["url"], "message": str(exc)[:300]})
                with self.lock:
                    self.progress[slot]["done"] = True
                    self.partial = _ordered(found)

            videos = _ordered(found)
            with self.lock:
                if videos and ok_sources:
                    self.videos, self.updated_at = videos, time.time()
                    write_json(REGISTRY_FILE, {"updated_at": self.updated_at, "videos": videos})
                    log("episode list ready:", len(videos), "episodes")
                elif not self.videos:
                    self.errors.append({"source": "all", "message": "No episodes found. Check your connection and try Refresh."})
        except Exception as exc:
            traceback.print_exc()
            with self.lock:
                self.errors.append({"source": "all", "message": str(exc)[:300]})
        finally:
            with self.lock:
                self.building = False
                self.partial = []


def _ordered(found):
    """Oldest first: by approximate upload date when YouTube gives one, else by era and channel order.
    Channel tabs list newest first, so a higher index within a channel means older."""
    have_ts = sum(1 for v in found if v["ts"]) > len(found) * 0.8
    if have_ts:
        ordered = sorted(found, key=lambda v: (v["ts"] or 0, v["_sort"][0], -v["_sort"][2]))
    else:
        ordered = sorted(found, key=lambda v: (v["_sort"][0], v["_sort"][1], -v["_sort"][2]))
    return [{k: val for k, val in v.items() if k != "_sort"} for v in ordered]


# --------------------------------------------------------------------------- captions


class CaptionError(Exception):
    def __init__(self, code, message, status=404):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def clean(text):
    text = html.unescape(text or "").replace("\n", " ")
    return re.sub(r"\s+", " ", text).strip()


def segs(items):
    out = []
    for s in items:
        text = clean(s["text"])
        if text:
            out.append({"t": round(float(s["start"]), 3), "d": round(float(s.get("duration") or 0), 3), "x": text})
    out.sort(key=lambda s: s["t"])
    return out


def _lang(t):
    return (t.language_code or "").lower()


def _can_translate_to(t, code):
    return any((getattr(l, "language_code", None) or l.get("language_code")) == code for l in (t.translation_languages or []))


def via_transcript_api(video_id, en_pref):
    from youtube_transcript_api import YouTubeTranscriptApi

    try:
        tracks = list(YouTubeTranscriptApi().list(video_id))
    except Exception as exc:
        name = type(exc).__name__
        if name in ("TranscriptsDisabled", "NoTranscriptFound"):
            raise CaptionError("no_captions", "This episode has no captions on YouTube.")
        if name in ("VideoUnavailable", "InvalidVideoId"):
            raise CaptionError("unavailable", "YouTube says this video is unavailable.")
        if name == "AgeRestricted":
            raise CaptionError("age_restricted", "This video is age-restricted, so its captions can't be read without signing in.")
        raise

    ar_manual = [t for t in tracks if _lang(t).startswith("ar") and not t.is_generated]
    ar_auto = [t for t in tracks if _lang(t).startswith("ar") and t.is_generated]
    en_manual = [t for t in tracks if _lang(t).startswith("en") and not t.is_generated]
    en_auto = [t for t in tracks if _lang(t).startswith("en") and t.is_generated]

    base = (ar_manual or ar_auto or [None])[0]
    if base is not None:
        ar_kind = "official" if not base.is_generated else "auto"
        ar = segs(base.fetch().to_raw_data())
    else:
        # No Arabic track at all: use YouTube's Arabic translation of whatever track exists.
        src = next((t for t in tracks if _can_translate_to(t, "ar")), None)
        if src is None:
            raise CaptionError("no_arabic", "This episode has no Arabic captions on YouTube.")
        base, ar_kind = src, "translated"
        ar = segs(src.translate("ar").fetch().to_raw_data())

    options = []
    if en_manual:
        options.append("official")
    if base is not None and not _lang(base).startswith("en") and _can_translate_to(base, "en"):
        options.append("translated")
    if en_auto and not options:
        options.append("auto")

    en_kind = en_pref if en_pref in options else (options[0] if options else None)
    en = []
    if en_kind == "official":
        en = segs(en_manual[0].fetch().to_raw_data())
    elif en_kind == "translated":
        en = segs(base.translate("en").fetch().to_raw_data())
    elif en_kind == "auto":
        en = segs(en_auto[0].fetch().to_raw_data())

    return {"ar": ar, "en": en, "ar_kind": ar_kind, "en_kind": en_kind, "en_options": options, "via": "youtube-transcript-api"}


def via_ytdlp(video_id, en_pref):
    """Fallback when the first method is blocked: read caption tracks through yt-dlp."""
    import yt_dlp

    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as ydl:
        info = ydl.extract_info("https://www.youtube.com/watch?v=" + video_id, download=False)
        subs = info.get("subtitles") or {}
        auto = info.get("automatic_captions") or {}

        def url_of(tracks, prefixes):
            for p in prefixes:
                for code, fmts in tracks.items():
                    if code.lower() == p or (p.endswith("*") and code.lower().startswith(p[:-1])):
                        for f in fmts:
                            if f.get("ext") == "json3":
                                return f["url"]
            return None

        def load(url):
            data = json.loads(ydl.urlopen(url).read().decode("utf-8"))
            items = []
            for ev in data.get("events", []):
                text = "".join(s.get("utf8", "") for s in ev.get("segs") or [])
                if text.strip():
                    items.append({"text": text, "start": ev.get("tStartMs", 0) / 1000, "duration": ev.get("dDurationMs", 0) / 1000})
            return segs(items)

        ar_url, ar_kind = url_of(subs, ["ar", "ar*"]), "official"
        if not ar_url:
            ar_url, ar_kind = url_of(auto, ["ar-orig", "ar"]), "auto"
        if not ar_url:
            raise CaptionError("no_arabic", "This episode has no Arabic captions on YouTube.")

        options, en_urls = [], {}
        official = url_of(subs, ["en", "en*"])
        if official:
            options.append("official")
            en_urls["official"] = official
        en_urls["translated"] = ar_url.split("&tlang=")[0] + "&tlang=en"
        options.append("translated")
        en_kind = en_pref if en_pref in options else options[0]
        try:
            en = load(en_urls[en_kind])
        except Exception:
            en, en_kind = [], None
        return {"ar": load(ar_url), "en": en, "ar_kind": ar_kind, "en_kind": en_kind, "en_options": options, "via": "yt-dlp"}


def align(ar, en):
    """One row per Arabic caption; each English caption joins the row it overlaps most."""
    rows = [{"t": a["t"], "d": a["d"], "ar": a["x"], "en": ""} for a in ar]
    if not rows or not en:
        return rows
    if len(ar) == len(en) and all(abs(a["t"] - e["t"]) < 0.25 for a, e in zip(ar, en)):
        for row, e in zip(rows, en):
            row["en"] = e["x"]
        return rows
    starts = [r["t"] for r in rows]
    buckets = [[] for _ in rows]
    for e in en:
        mid = e["t"] + min(e["d"], 8) / 2
        i = max(0, bisect.bisect_right(starts, mid) - 1)
        buckets[i].append(e["x"])
    for row, b in zip(rows, buckets):
        row["en"] = " ".join(b)
    return rows


_fetch_locks = {}
_fetch_locks_guard = threading.Lock()


def get_transcript(video_id, en_pref=None):
    en_pref = en_pref if en_pref in ("official", "translated", "auto") else None
    cache_file = CACHE / "{}.{}.json".format(video_id, en_pref or "default")
    if cache_file.exists():
        return json.loads(cache_file.read_text("utf-8"))

    with _fetch_locks_guard:
        lock = _fetch_locks.setdefault(cache_file.name, threading.Lock())
    with lock:  # two tabs asking for the same episode wait for one fetch
        if cache_file.exists():
            return json.loads(cache_file.read_text("utf-8"))
        errors = []
        result = None
        for method in (via_transcript_api, via_ytdlp):
            try:
                result = method(video_id, en_pref)
                break
            except CaptionError:
                raise
            except Exception as exc:
                name = type(exc).__name__
                log("  {} failed: {}: {}".format(method.__name__, name, str(exc).splitlines()[0][:200] if str(exc) else ""))
                errors.append(name)
        if result is None:
            blocked = any(n in ("RequestBlocked", "IpBlocked", "PoTokenRequired") for n in errors)
            raise CaptionError(
                "blocked" if blocked else "fetch_failed",
                "YouTube is temporarily refusing caption requests from your network. Wait a few minutes and try again."
                if blocked else "Couldn't load captions from YouTube right now. Check your connection and try again.",
                status=502,
            )
        payload = {
            "id": video_id,
            "rows": align(result["ar"], result["en"]),
            "ar_kind": result["ar_kind"],
            "en_kind": result["en_kind"],
            "en_options": result["en_options"],
            "via": result["via"],
            "fetched_at": time.time(),
        }
        write_json(cache_file, payload)
        return payload


# --------------------------------------------------------------------------- http

REGISTRY = None
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json"}


class Handler(BaseHTTPRequestHandler):
    server_version = "DahihPlayer/1.0"

    def log_message(self, fmt, *args):
        pass  # keep the terminal readable

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_static(self, rel):
        path = (STATIC / rel).resolve()
        if STATIC.resolve() not in path.parents or not path.is_file():
            return self.send_json({"error": "not_found"}, 404)
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(path.suffix, "application/octet-stream"))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        if url.path == "/api/registry":
            return self.send_json(REGISTRY.snapshot())
        if url.path == "/api/transcript":
            vid = (q.get("id") or [""])[0]
            if not VIDEO_ID.match(vid):
                return self.send_json({"error": "bad_id", "message": "Not a YouTube video id."}, 400)
            try:
                log("captions", vid, "…")
                data = get_transcript(vid, (q.get("en") or [None])[0])
                log("captions", vid, "ok,", len(data["rows"]), "lines")
                return self.send_json(data)
            except CaptionError as exc:
                log("captions", vid, "->", exc.code)
                return self.send_json({"error": exc.code, "message": exc.message}, exc.status)
            except Exception as exc:
                traceback.print_exc()
                return self.send_json({"error": "server_error", "message": str(exc)[:300]}, 500)
        if url.path == "/api/health":
            return self.send_json({"ok": True})
        if url.path in ("/", "/index.html"):
            return self.send_static("index.html")
        return self.send_static(url.path.lstrip("/"))

    def do_POST(self):
        if urlparse(self.path).path == "/api/registry/refresh":
            started = REGISTRY.refresh()
            return self.send_json({"started": started, **REGISTRY.snapshot()})
        return self.send_json({"error": "not_found"}, 404)


def free_port(start):
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("No free port found near {}".format(start))


def main():
    global REGISTRY
    ap = argparse.ArgumentParser(description="El Dahih bilingual player")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--open", action="store_true", help="open the player in your browser")
    ap.add_argument("--no-refresh", action="store_true", help="don't update the episode list on start")
    args = ap.parse_args()

    CACHE.mkdir(parents=True, exist_ok=True)
    REGISTRY = Registry()
    if REGISTRY.stale() and not args.no_refresh:
        REGISTRY.refresh()

    port = free_port(args.port)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    url = "http://localhost:{}/".format(port)
    log("El Dahih player running at", url, " (close this window or press Ctrl+C to stop)")
    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    sys.exit(main())
