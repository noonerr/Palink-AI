import random
import requests
from flask import Flask, request, jsonify

app = Flask(__name__)

SEARXNG_URL = "http://searxng:8080"

ENGINE_POOL = [
    "google", "bing", "duckduckgo", "brave", "qwant",
    "startpage", "mojeek", "ecosia", "yandex", "yahoo",
    "wikidata", "wikipedia", "ddg definitions",
]

recent_engines = []
MAX_RECENT = 3


@app.route("/search", methods=["GET"])
def search():
    q = request.args.get("q", "")
    if not q:
        return jsonify({"error": "missing query parameter 'q'"}), 400

    format_type = request.args.get("format", "json")
    language = request.args.get("language", request.args.get("lng", "auto"))
    categories = request.args.get("categories", "general")

    available = [e for e in ENGINE_POOL if e not in recent_engines]
    if not available:
        available = ENGINE_POOL
        recent_engines.clear()

    chosen = random.choice(available)
    recent_engines.append(chosen)
    if len(recent_engines) > MAX_RECENT:
        recent_engines.pop(0)

    params = {
        "q": q,
        "format": format_type,
        "engines": chosen,
        "language": language,
        "categories": categories,
    }

    try:
        resp = requests.get(f"{SEARXNG_URL}/search", params=params, timeout=15)
        if resp.status_code == 200:
            if format_type == "json":
                data = resp.json()
                data["_meta"] = {"engine_used": chosen, "pool_size": len(ENGINE_POOL)}
                return jsonify(data)
            return resp.text, 200
        return jsonify({"error": f"SearXNG returned {resp.status_code}", "engine": chosen}), resp.status_code
    except requests.exceptions.Timeout:
        return jsonify({"error": "SearXNG timeout", "engine": chosen}), 504
    except Exception as e:
        return jsonify({"error": str(e), "engine": chosen}), 500


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "engine_pool": ENGINE_POOL, "recent": recent_engines})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8889)
