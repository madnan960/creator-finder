const BASE = "https://www.googleapis.com/youtube/v3";

const MUSIC_SIGNALS = ["vevo", "official artist", "- topic", "official music",
  "records", "music video", "lyrics", "album", "mixtape", "beats",
  "instrumental", "audio library", "no copyright music", "ncs", "remix",
  "dj ", "soundtrack", "official audio"];
const MUSIC_CATEGORY_ID = "10";
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

async function apiGet(endpoint, params, key) {
  params.key = key;
  const url = `${BASE}/${endpoint}?` + new URLSearchParams(params).toString();
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.text();
    throw { status: r.status, body };
  }
  return r.json();
}

function isEnglishText(text) {
  if (!text) return true;
  const letters = [...text].filter(c => /\p{L}/u.test(c));
  if (!letters.length) return true;
  const ascii = letters.filter(c => c.charCodeAt(0) < 128).length;
  return ascii / letters.length >= 0.8;
}

function looksLikeMusic(ch) {
  const blob = (ch.snippet.title + " " + (ch.snippet.description || "")).toLowerCase();
  return MUSIC_SIGNALS.some(s => blob.includes(s));
}

function extractEmail(desc) {
  const m = (desc || "").match(EMAIL_RE);
  return m ? m[0] : "";
}

async function searchChannels(keyword, maxResults, key) {
  let out = [], token = null, fetched = 0;
  while (fetched < maxResults) {
    const params = {
      part: "snippet", q: keyword, type: "channel",
      maxResults: Math.min(50, maxResults - fetched),
      relevanceLanguage: "en",
    };
    if (token) params.pageToken = token;
    const d = await apiGet("search", params, key);
    if (!d.items) break;
    out.push(...d.items.map(i => i.snippet.channelId));
    fetched += d.items.length;
    token = d.nextPageToken;
    if (!token) break;
  }
  return out;
}

async function getChannelStats(ids, key) {
  const res = {};
  for (let i = 0; i < ids.length; i += 50) {
    const d = await apiGet("channels", {
      part: "snippet,statistics,contentDetails",
      id: ids.slice(i, i + 50).join(","),
    }, key);
    if (d.items) for (const it of d.items) res[it.id] = it;
  }
  return res;
}

async function recentInfo(playlist, key) {
  const d = await apiGet("playlistItems", {
    part: "contentDetails", playlistId: playlist, maxResults: 5,
  }, key);
  if (!d.items || !d.items.length) return { mx: 0, music: false, audioEn: true };
  const vids = d.items.map(it => it.contentDetails.videoId);
  const v = await apiGet("videos", { part: "statistics,snippet", id: vids.join(",") }, key);
  if (!v.items) return { mx: 0, music: false, audioEn: true };
  let mx = 0, music = 0, audioEn = true;
  for (const x of v.items) {
    mx = Math.max(mx, parseInt(x.statistics?.viewCount || 0));
    if (x.snippet.categoryId === MUSIC_CATEGORY_ID) music++;
    for (const k of ["defaultAudioLanguage", "defaultLanguage"]) {
      const lang = x.snippet[k] || "";
      if (lang && !lang.toLowerCase().startsWith("en")) audioEn = false;
    }
  }
  return { mx, music: music >= Math.max(1, Math.floor(v.items.length / 2)), audioEn };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }
  const { apiKey, keywords, minSubs, minViews, perKeyword, exclude } = req.body || {};
  if (!apiKey) return res.status(400).json({ error: "API key chahiye." });
  if (!keywords || !keywords.length) return res.status(400).json({ error: "Keywords chahiye." });

  const MIN_SUBS = parseInt(minSubs) || 200000;
  const MIN_VIEWS = parseInt(minViews) || 100000;
  const PER_KEYWORD = Math.min(parseInt(perKeyword) || 50, 100);
  const VERIFIED_CEILING = 5000000;
  const known = new Set(exclude || []);

  const seen = new Set();
  const qualified = [];

  try {
    for (const kw of keywords) {
      let cids = await searchChannels(kw, PER_KEYWORD, apiKey);
      cids = cids.filter(c => !seen.has(c) && !known.has(c));
      cids.forEach(c => seen.add(c));
      const stats = await getChannelStats(cids, apiKey);
      for (const cid of Object.keys(stats)) {
        const ch = stats[cid];
        const s = ch.snippet;
        const subs = parseInt(ch.statistics?.subscriberCount || 0);
        if (subs < MIN_SUBS) continue;
        if (subs >= VERIFIED_CEILING) continue;
        if (!(isEnglishText(s.title) && isEnglishText(s.description))) continue;
        const dl = s.defaultLanguage || "";
        if (dl && !dl.toLowerCase().startsWith("en")) continue;
        if (looksLikeMusic(ch)) continue;
        const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
        if (!uploads) continue;
        const { mx, music, audioEn } = await recentInfo(uploads, apiKey);
        if (music || mx < MIN_VIEWS || !audioEn) continue;
        const handle = s.customUrl || "";
        qualified.push({
          name: s.title,
          link: "https://www.youtube.com/channel/" + cid,
          handle: handle ? "https://www.youtube.com/" + handle : "",
          subs,
          totalViews: parseInt(ch.statistics?.viewCount || 0),
          videos: parseInt(ch.statistics?.videoCount || 0),
          topRecentViews: mx,
          email: extractEmail(s.description),
          country: s.country || "",
          keyword: kw,
          channelId: cid,
        });
      }
    }
  } catch (e) {
    if (e.status === 403) {
      return res.status(403).json({ error: "API key galat hai ya daily quota khatam ho gaya. Kal try karein ya nayi key banayein." });
    }
    return res.status(500).json({ error: "Search fail hui: " + (e.body || e.message || "unknown") });
  }

  const uniq = {};
  for (const q of qualified) uniq[q.link] = q;
  const rows = Object.values(uniq).sort((a, b) => b.subs - a.subs);

  return res.status(200).json({ count: rows.length, creators: rows });
}
