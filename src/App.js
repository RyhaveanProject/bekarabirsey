import { useEffect, useState, useRef, useCallback } from "react";
import "@/App.css";
import axios from "axios";
import {
  Home as HomeIcon, Search as SearchIcon, Heart, Music2,
  Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1,
  ChevronDown, Volume2, ListMusic, Plus, MoreHorizontal,
  Loader2, TrendingUp, Sparkles, Clock
} from "lucide-react";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

/* ---------- helpers ---------- */
const fmtTime = (s) => {
  if (!s || isNaN(s)) return "0:00";
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
};

const getSessionId = () => {
  let id = localStorage.getItem("ryhavean_session");
  if (!id) {
    id = "sess_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("ryhavean_session", id);
  }
  return id;
};

const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

/* ---------- YT API ---------- */
let ytApiPromise = null;

const loadYTApi = () => {
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }

    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.body.appendChild(tag);

    window.onYouTubeIframeAPIReady = () => {
      resolve(window.YT);
    };
  });

  return ytApiPromise;
};

/* ---------- Dynamic background ---------- */
const sampleImageColor = (imgUrl) =>
  new Promise((resolve) => {
    if (!imgUrl) return resolve(null);

    const img = new Image();
    img.crossOrigin = "Anonymous";

    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 20;
        canvas.height = 20;

        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, 20, 20);

        const data = ctx.getImageData(0, 0, 20, 20).data;

        let r = 0, g = 0, b = 0, n = 0;

        for (let i = 0; i < data.length; i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }

        resolve([
          Math.round(r / n),
          Math.round(g / n),
          Math.round(b / n)
        ]);
      } catch {
        resolve(null);
      }
    };

    img.onerror = () => resolve(null);
    img.src = imgUrl;
  });

/* ---------- Toast ---------- */
const useToast = () => {
  const [msg, setMsg] = useState(null);

  const show = (m) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2400);
  };

  const node = msg ? (
    <div className="toast" data-testid="toast">
      {msg}
    </div>
  ) : null;

  return { show, node };
};

/* ---------- Player ---------- */
const usePlayer = (toast) => {
  const [current, setCurrent] = useState(null);
  const [queue, setQueue] = useState([]);
  const [history, setHistory] = useState([]);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.9);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState("off");
  const [fullOpen, setFullOpen] = useState(false);
  const [loadingStream, setLoadingStream] = useState(false);

  const ytPlayerRef = useRef(null);
  const ytReadyRef = useRef(false);
  const progressTimerRef = useRef(null);

  const ytDivId = "yt-player-host";

  const sessionId = getSessionId();

  /* init yt */
  useEffect(() => {
    let cancelled = false;

    loadYTApi().then((YT) => {
      if (cancelled) return;

      ytPlayerRef.current = new YT.Player(ytDivId, {
        height: "1",
        width: "1",

        playerVars: {
          autoplay: 0,
          controls: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1
        },

        events: {
          onReady: () => {
            ytReadyRef.current = true;

            try {
              ytPlayerRef.current.setVolume(90);
            } catch {}
          },

          onStateChange: (e) => {
            if (e.data === 1) {
              setPlaying(true);
              setLoadingStream(false);
            }

            if (e.data === 2) {
              setPlaying(false);
            }

            if (e.data === 0) {
              if (repeat === "one") {
                try {
                  ytPlayerRef.current.seekTo(0, true);
                  ytPlayerRef.current.playVideo();
                } catch {}
              } else {
                next();
              }
            }
          },

          onError: () => {
            toast.show("Video unavailable");
            next();
          }
        }
      });
    });

    return () => {
      cancelled = true;
    };
  }, [repeat]);

  /* progress */
  useEffect(() => {
    progressTimerRef.current = setInterval(() => {
      const p = ytPlayerRef.current;

      if (!p || !ytReadyRef.current) return;

      try {
        setProgress(p.getCurrentTime() || 0);
        setDuration(p.getDuration() || 0);
      } catch {}
    }, 500);

    return () => {
      clearInterval(progressTimerRef.current);
    };
  }, []);

  /* volume */
  useEffect(() => {
    try {
      if (ytPlayerRef.current) {
        ytPlayerRef.current.setVolume(volume * 100);
      }
    } catch {}
  }, [volume]);

  const play = useCallback(async (song, opts = {}) => {
    if (!song || !song.id) return;

    setLoadingStream(true);

    const prev = current;

    setCurrent(song);
    setPlaying(true);
    setProgress(0);

    for (let i = 0; i < 20 && !ytReadyRef.current; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }

    try {
      ytPlayerRef.current.loadVideoById(song.id);
      ytPlayerRef.current.playVideo();
    } catch {
      toast.show("Playback failed");
      setLoadingStream(false);
    }

    axios.post(`${API}/recently-played`, {
      session_id: sessionId,
      song: {
        id: song.id,
        title: song.title,
        artist: song.artist,
        duration: song.duration || 0,
        thumbnail: song.thumbnail || ""
      }
    }).catch(() => {});

    if (!opts.skipHistory && prev) {
      setHistory((h) => [prev, ...h].slice(0, 50));
    }
  }, [current, sessionId, toast]);

  const togglePlay = () => {
    const p = ytPlayerRef.current;

    if (!p || !current) return;

    try {
      const state = p.getPlayerState();

      if (state === 1) {
        p.pauseVideo();
        setPlaying(false);
      } else {
        p.playVideo();
        setPlaying(true);
      }
    } catch {}
  };

  const next = useCallback(async () => {
    let nextSong = null;

    if (queue.length) {
      const q = [...queue];

      if (shuffle) {
        const idx = Math.floor(Math.random() * q.length);
        nextSong = q.splice(idx, 1)[0];
      } else {
        nextSong = q.shift();
      }

      setQueue(q);
    }

    if (nextSong) {
      play(nextSong);
    }
  }, [queue, shuffle, play]);

  const prev = () => {
    if (history.length) {
      const h = [...history];
      const p = h.shift();

      setHistory(h);

      if (p) play(p, { skipHistory: true });
    } else {
      try {
        ytPlayerRef.current.seekTo(0, true);
      } catch {}
    }
  };

  const seek = (ratio) => {
    try {
      const dur = ytPlayerRef.current.getDuration();

      ytPlayerRef.current.seekTo(dur * ratio, true);
    } catch {}
  };

  const enqueue = (song) => {
    setQueue((q) => [...q, song]);

    toast.show(`Added: ${song.title}`);
  };

  return {
    current,
    queue,
    playing,
    progress,
    duration,
    volume,
    shuffle,
    repeat,
    fullOpen,
    loadingStream,
    sessionId,
    ytDivId,

    play,
    togglePlay,
    next,
    prev,
    seek,
    enqueue,

    setShuffle,
    setRepeat,
    setVolume,
    setFullOpen,
    setQueue
  };
};

/* ---------- Dynamic BG ---------- */
const useDynamicBg = (song) => {
  useEffect(() => {
    if (!song?.thumbnail) return;

    sampleImageColor(song.thumbnail).then((rgb) => {
      if (!rgb) return;

      const [r, g, b] = rgb;

      const grad =
        `radial-gradient(at top, rgba(${r},${g},${b},0.9), #0a0a0b 70%)`;

      document.documentElement.style.setProperty("--dyn-grad", grad);
    });
  }, [song?.thumbnail]);
};

/* ---------- App ---------- */
function App() {
  const toast = useToast();
  const player = usePlayer(toast);

  useDynamicBg(player.current);

  return (
    <div className="app-shell">
      <div className="dynamic-bg" />

      <div id={player.ytDivId} className="yt-host" />

      {toast.node}
    </div>
  );
}

export default App;
