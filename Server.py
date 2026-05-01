"""
Ryhavean Spotify - FastAPI backend
YouTube metadata/search + favorites + trending
Playback handled by YouTube IFrame API on frontend
"""

from fastapi import FastAPI, APIRouter, HTTPException, Query
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pathlib import Path
from pydantic import BaseModel
from datetime import datetime, timezone
from typing import Optional
import asyncio
import yt_dlp
import os
import logging

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

app = FastAPI(title="Ryhavean Spotify")
api = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ryhavean")

# ---------------- yt-dlp ----------------

YDL_SEARCH_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "extract_flat": True,
    "default_search": "ytsearch",
    "noplaylist": True,
}

YDL_STREAM_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "format": "bestaudio/best",
    "noplaylist": True,
}

def _search_sync(query: str, limit: int = 20):
    with yt_dlp.YoutubeDL(YDL_SEARCH_OPTS) as ydl:
        info = ydl.extract_info(
            f"ytsearch{limit}:{query}",
            download=False
        )

    entries = info.get("entries", []) if info else []
    results = []

    for e in entries:
        if not e:
            continue

        vid = e.get("id")
        if not vid:
            continue

        thumbs = e.get("thumbnails") or []

        results.append({
            "id": vid,
            "title": e.get("title", "Unknown"),
            "artist": e.get("uploader") or e.get("channel") or "Unknown",
            "duration": int(e.get("duration") or 0),
            "thumbnail": (
                thumbs[-1]["url"]
                if thumbs
                else f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
            ),
        })

    return results


def _stream_sync(video_id: str):
    url = f"https://www.youtube.com/watch?v={video_id}"

    with yt_dlp.YoutubeDL(YDL_STREAM_OPTS) as ydl:
        info = ydl.extract_info(url, download=False)

    if not info:
        return None

    return {
        "title": info.get("title"),
        "artist": info.get("uploader") or info.get("channel"),
        "duration": int(info.get("duration") or 0),
        "thumbnail": (
            info.get("thumbnails")[-1]["url"]
            if info.get("thumbnails")
            else f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
        ),
    }


async def yt_search(query: str, limit: int = 20):
    return await asyncio.to_thread(_search_sync, query, limit)


async def yt_stream(video_id: str):
    return await asyncio.to_thread(_stream_sync, video_id)

# ---------------- Models ----------------

class Song(BaseModel):
    id: str
    title: str
    artist: str
    duration: int = 0
    thumbnail: str = ""


class FavoriteCreate(BaseModel):
    session_id: str
    song: Song


# ---------------- Helpers ----------------

async def increment_play(video_id: str, data: dict):
    await db.play_counts.update_one(
        {"id": video_id},
        {
            "$inc": {"plays": 1},
            "$set": {
                "title": data.get("title"),
                "artist": data.get("artist"),
                "thumbnail": data.get("thumbnail"),
                "duration": data.get("duration"),
                "last_played": datetime.now(timezone.utc).isoformat(),
            },
        },
        upsert=True,
    )

# ---------------- Routes ----------------

@api.get("/")
async def root():
    return {
        "app": "Ryhavean Spotify",
        "status": "ok"
    }


@api.get("/search")
async def search(
    q: str = Query(..., min_length=1),
    limit: int = 20
):
    try:
        results = await yt_search(q, limit)
        return {
            "query": q,
            "results": results
        }

    except Exception as e:
        logger.exception("search failed")
        raise HTTPException(
            status_code=500,
            detail=str(e)
        )


@api.get("/stream-info/{video_id}")
async def stream_info(video_id: str):

    data = None

    try:
        data = await yt_stream(video_id)
    except Exception:
        logger.exception("yt-dlp failed")

    if not data:
        try:
            results = await yt_search(video_id, 1)

            if results:
                data = results[0]

        except Exception:
            pass

    if not data:
        data = {
            "title": "Unknown",
            "artist": "Unknown",
            "duration": 0,
            "thumbnail": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        }

    await increment_play(video_id, data)

    return {
        "video_id": video_id,
        "title": data.get("title"),
        "artist": data.get("artist"),
        "duration": data.get("duration"),
        "thumbnail": data.get("thumbnail"),
    }


@api.get("/recommendations/{video_id}")
async def recommendations(video_id: str):

    try:
        meta = None

        try:
            results = await yt_search(video_id, 1)

            if results:
                meta = results[0]

        except Exception:
            pass

        query = (
            (meta.get("artist") if meta else None)
            or
            (meta.get("title") if meta else None)
            or
            "top hits"
        )

        results = await yt_search(query, 20)

        results = [
            r for r in results
            if r["id"] != video_id
        ]

        return {
            "results": results
        }

    except Exception:
        logger.exception("recommendations failed")
        return {
            "results": []
        }


@api.get("/favorites")
async def favorites(session_id: str):

    items = (
        await db.favorites
        .find({"session_id": session_id}, {"_id": 0})
        .to_list(500)
    )

    return {
        "favorites": items
    }


@api.post("/favorites")
async def add_favorite(body: FavoriteCreate):

    doc = {
        "session_id": body.session_id,
        "song_id": body.song.id,
        "title": body.song.title,
        "artist": body.song.artist,
        "duration": body.song.duration,
        "thumbnail": body.song.thumbnail,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    await db.favorites.update_one(
        {
            "session_id": body.session_id,
            "song_id": body.song.id
        },
        {
            "$set": doc
        },
        upsert=True,
    )

    await db.like_counts.update_one(
        {"id": body.song.id},
        {
            "$inc": {"likes": 1},
            "$set": {
                "title": body.song.title,
                "artist": body.song.artist,
                "thumbnail": body.song.thumbnail,
                "duration": body.song.duration,
            },
        },
        upsert=True,
    )

    return {"ok": True}


@api.get("/trending")
async def trending(limit: int = 20):

    items = (
        await db.like_counts
        .find({}, {"_id": 0})
        .sort("likes", -1)
        .to_list(limit)
    )

    return {
        "trending": items
    }

# ---------------- App ----------------

app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown():
    client.close()
