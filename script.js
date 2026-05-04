import {
    auth,
    db,
    provider,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    onAuthStateChanged,
    signOut,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence,
    inMemoryPersistence,
    doc,
    setDoc,
    getDoc,
    collection,
    getDocs,
    addDoc,
    deleteDoc,
    serverTimestamp
} from './firebase.js';
import { GROQ_SYSTEM_PROMPT } from './groq-system-prompt.js';
import {
    CURATOR_ARTISTS,
    buildVibeStep1OutputContract,
    buildVibeStep2OutputContract,
    buildVibeReshuffleMusicContract,
    buildVibeReshufflePhilosophyContract,
    buildVibeReshuffleInteractiveContract
} from './curator-prompt.js';

/** Prefer model watch/results URL; else YouTube search for artist + song. */
function resolveYoutubeSongUrl(url, fallbackQuery) {
    if (url && typeof url === 'string') {
        const t = url.trim();
        if (/^https?:\/\//i.test(t)) {
            try {
                const u = new URL(t);
                const h = u.hostname.replace(/^www\./, '');
                if (h === 'youtube.com' || h === 'youtu.be' || h === 'm.youtube.com') return t;
            } catch {
                /* fall through */
            }
        }
    }
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(fallbackQuery)}`;
}

function youtubeHost(h) {
    return h === 'youtube.com' || h === 'm.youtube.com' || h === 'music.youtube.com';
}

function isLikelyYoutubeVideoId(v) {
    return typeof v === 'string' && /^[\w-]{11}$/.test(v.trim());
}

function normalizeNameLoose(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\w\s*']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function resolveCuratorArtistPick(raw) {
    const t = String(raw || '').trim();
    if (!t) {
        console.warn('slimemytaste: missing curatorArtistPick → Summrs');
        return 'Summrs';
    }
    const exact = CURATOR_ARTISTS.find((a) => a === t);
    if (exact) return exact;
    const tl = t.toLowerCase();
    const ci = CURATOR_ARTISTS.find((a) => a.toLowerCase() === tl);
    if (ci) return ci;
    const nt = normalizeNameLoose(t);
    const loose = CURATOR_ARTISTS.find((a) => normalizeNameLoose(a) === nt);
    if (loose) return loose;
    const partial = CURATOR_ARTISTS.find(
        (a) =>
            nt.includes(normalizeNameLoose(a)) ||
            normalizeNameLoose(a).includes(nt) ||
            tl.includes(a.toLowerCase()) ||
            a.toLowerCase().includes(tl)
    );
    if (partial) return partial;
    console.warn('slimemytaste: curatorArtistPick not in list:', raw, '→ Summrs');
    return 'Summrs';
}

function trackMatchesCuratorPick(track, canonicalArtist) {
    const pick = normalizeNameLoose(canonicalArtist);
    const artists = track?.artists || [];
    return artists.some((x) => {
        const n = normalizeNameLoose(x.name);
        return n === pick || n.includes(pick) || pick.includes(n);
    });
}

function buildSpotifySearchQueryForCurator(canonicalArtist, moodKeywords) {
    const kw = String(moodKeywords || '').trim();
    const esc = String(canonicalArtist || '').replace(/"/g, '').trim();
    if (!esc) return kw || 'Summrs';
    return kw ? `artist:"${esc}" ${kw}` : `artist:"${esc}"`;
}

/** Unique id per vibe run so Groq treats each journal click as a fresh curation. */
function vibeSessionStamp() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function googleExploreUrlForPhilosophyName(name) {
    const q = String(name || '').trim();
    return `https://www.google.com/search?q=${encodeURIComponent(q || 'design philosophy')}`;
}

function coercePhilosophyExploreUrl(ph) {
    if (!ph || typeof ph !== 'object') return;
    const name = String(ph.name || '').trim();
    const raw = String(ph.exploreUrl || '').trim();
    if (raw) {
        try {
            const u = new URL(raw);
            const h = u.hostname.replace(/^www\./, '');
            if (h === 'google.com' && u.pathname.startsWith('/search')) {
                ph.exploreUrl = raw;
                return;
            }
        } catch {
            /* fall through */
        }
    }
    ph.exploreUrl = googleExploreUrlForPhilosophyName(name);
}

const INTERACTIVE_URL_CANON = new Set(
    [
        'https://neal.fun',
        'https://neal.fun/deep-sea',
        'https://neal.fun/the-size-of-space',
        'https://neal.fun/spend/',
        'https://neal.fun/infinite-craft',
        'https://neal.fun/password',
        'https://neal.fun/ambient-chaos',
        'https://theuselessweb.com',
        'https://patatap.com',
        'https://radio.garden',
        'https://itch.io/games/tag-atmospheric/tag-melancholy',
        'https://itch.io/games/tag-dark/tag-experimental',
        'https://itch.io/games/tag-narrative/tag-personal',
        'https://itch.io/games/tag-experimental/tag-weird',
        'https://itch.io/games/tag-walking-simulator',
        'https://itch.io/games/tag-emotional/tag-story-rich'
    ].map((s) => canonicalizeInteractiveUrlString(s))
);

function canonicalizeInteractiveUrlString(raw) {
    const u = new URL(String(raw).trim());
    u.hash = '';
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    let path = u.pathname || '/';
    if (h === 'neal.fun') {
        if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1);
        if (path === '/spend') path = '/spend/';
    } else if (h === 'itch.io') {
        if (path.endsWith('/')) path = path.slice(0, -1);
    } else if (h === 'theuselessweb.com' || h === 'patatap.com' || h === 'radio.garden') {
        path = '/';
    }
    return `https://${h}${path === '/' ? '' : path}`;
}

function urlPassesInteractiveAllowlist(raw) {
    if (!raw || typeof raw !== 'string') return false;
    try {
        const key = canonicalizeInteractiveUrlString(raw);
        return INTERACTIVE_URL_CANON.has(key);
    } catch {
        return false;
    }
}

function interactiveSourceLabelFromUrl(url) {
    try {
        const h = new URL(String(url).trim()).hostname.replace(/^www\./, '').toLowerCase();
        if (h === 'neal.fun') return 'neal.fun';
        if (h === 'theuselessweb.com') return 'theuselessweb.com';
        if (h === 'patatap.com') return 'patatap.com';
        if (h === 'itch.io') return 'itch.io';
        if (h === 'radio.garden') return 'radio.garden';
        return h;
    } catch {
        return '';
    }
}

function normalizeRecommendationUrls(rec) {
    if (!rec || typeof rec !== 'object') return rec;
    const song = rec.artist?.song || '';
    const name = rec.artist?.name || '';
    const spotifyQ = [song, name].filter(Boolean).join(' ').trim() || name || 'music';
    if (rec.artist && typeof rec.artist === 'object') {
        if (!String(rec.artist.searchUrl || '').trim()) {
            rec.artist.searchUrl = `https://open.spotify.com/search/${encodeURIComponent(spotifyQ)}`;
        }
        const ytCandidate =
            rec.artist.songYoutubeUrl ||
            (/youtube\.com\/watch|youtu\.be\//i.test(String(rec.artist.albumCover || ''))
                ? rec.artist.albumCover
                : null);
        rec.artist.songYoutubeUrl = resolveYoutubeSongUrl(ytCandidate, spotifyQ);
        rec.artist.songSoundcloudUrl = `https://soundcloud.com/search/sounds?q=${encodeURIComponent(spotifyQ)}`;
    }
    if (rec.philosophy && typeof rec.philosophy === 'object') coercePhilosophyExploreUrl(rec.philosophy);
    if (rec.interactive && typeof rec.interactive === 'object') {
        const url = String(rec.interactive.url || '').trim();
        if (url && urlPassesInteractiveAllowlist(url)) {
            try {
                rec.interactive.url = canonicalizeInteractiveUrlString(url);
            } catch {
                /* keep raw */
            }
        }
    }
    const trails = Array.isArray(rec.searchTrails)
        ? rec.searchTrails.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 3)
        : [];
    rec.searchTrails = trails;
    rec.searchUrls = trails.length ? trails.map((t) => `https://www.google.com/search?q=${encodeURIComponent(t)}`) : [];
    return rec;
}

const GROQ_KEY_STORAGE = 'mymotif_groq_api_key_v1';

/** Inline override for dev only — prefer pasting in the post-login prompt (stored in localStorage). */
function getGroqApiKey() {
    try {
        const w =
            typeof window !== 'undefined' &&
            typeof window.MYMOTIF_GROQ_API_KEY === 'string' &&
            window.MYMOTIF_GROQ_API_KEY.trim();
        if (w) return window.MYMOTIF_GROQ_API_KEY.trim();
        const s = localStorage.getItem(GROQ_KEY_STORAGE);
        return s && s.trim() ? s.trim() : '';
    } catch {
        return '';
    }
}

function saveGroqApiKey(key) {
    const t = String(key || '').trim();
    if (!t) return false;
    try {
        localStorage.setItem(GROQ_KEY_STORAGE, t);
        return true;
    } catch {
        return false;
    }
}

const SPOTIFY_CLIENT_ID_KEY = 'mymotif_spotify_client_id_v1';
const SPOTIFY_CLIENT_SECRET_KEY = 'mymotif_spotify_client_secret_v1';

/** Optional — improves metadata; iTunes fallback resolves real tracks without these. */
function getSpotifyClientId() {
    try {
        const w =
            typeof window !== 'undefined' &&
            typeof window.MYMOTIF_SPOTIFY_CLIENT_ID === 'string' &&
            window.MYMOTIF_SPOTIFY_CLIENT_ID.trim();
        if (w) return window.MYMOTIF_SPOTIFY_CLIENT_ID.trim();
        const s = localStorage.getItem(SPOTIFY_CLIENT_ID_KEY);
        return s && s.trim() ? s.trim() : '';
    } catch {
        return '';
    }
}

function getSpotifyClientSecret() {
    try {
        const w =
            typeof window !== 'undefined' &&
            typeof window.MYMOTIF_SPOTIFY_CLIENT_SECRET === 'string' &&
            window.MYMOTIF_SPOTIFY_CLIENT_SECRET.trim();
        if (w) return window.MYMOTIF_SPOTIFY_CLIENT_SECRET.trim();
        const s = localStorage.getItem(SPOTIFY_CLIENT_SECRET_KEY);
        return s && s.trim() ? s.trim() : '';
    } catch {
        return '';
    }
}

function hasSpotifyCredentials() {
    return !!(getSpotifyClientId() && getSpotifyClientSecret());
}

function saveSpotifyCredentials(id, secret) {
    try {
        localStorage.setItem(SPOTIFY_CLIENT_ID_KEY, String(id || '').trim());
        localStorage.setItem(SPOTIFY_CLIENT_SECRET_KEY, String(secret || '').trim());
        return true;
    } catch {
        return false;
    }
}

let spotifyTokenCache = { accessToken: '', expiresAt: 0 };

async function fetchSpotifyAccessToken() {
    const id = getSpotifyClientId();
    const secret = getSpotifyClientSecret();
    if (!id || !secret) throw new Error('missing_credentials');
    const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + btoa(`${id}:${secret}`)
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' })
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(err || `Spotify auth HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data.access_token) throw new Error('Spotify auth: no access_token');
    return { token: data.access_token, expiresIn: data.expires_in || 3600 };
}

async function spotifyApiSearchFirstTrack(query) {
    let token = spotifyTokenCache.accessToken;
    if (!token || Date.now() > spotifyTokenCache.expiresAt - 60_000) {
        const t = await fetchSpotifyAccessToken();
        spotifyTokenCache = {
            accessToken: t.token,
            expiresAt: Date.now() + t.expiresIn * 1000
        };
        token = t.token;
    }
    const res = await fetch(
        `https://api.spotify.com/v1/search?${new URLSearchParams({
            q: query,
            type: 'track',
            limit: '10'
        })}`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Spotify search HTTP ${res.status}`);
    const data = await res.json();
    const items = data.tracks?.items;
    if (!items?.length) throw new Error('Spotify returned no tracks');
    return items[0];
}

async function itunesSearchFirstTrack(query) {
    const res = await fetch(
        `https://itunes.apple.com/search?${new URLSearchParams({
            term: query,
            media: 'music',
            entity: 'song',
            limit: '10'
        })}`
    );
    if (!res.ok) throw new Error(`iTunes HTTP ${res.status}`);
    const data = await res.json();
    const r = data.results?.[0];
    if (!r) throw new Error('No songs found for search');
    const art = r.artworkUrl100
        ? r.artworkUrl100.replace(/100x100bb/g, '600x600bb')
        : null;
    return {
        name: r.trackName,
        artists: [{ name: r.artistName }],
        album: {
            name: r.collectionName,
            images: art ? [{ url: art }] : []
        },
        external_urls: {
            spotify: `https://open.spotify.com/search/${encodeURIComponent(`${r.artistName} ${r.trackName}`)}`
        },
        preview_url: r.previewUrl || null
    };
}

/**
 * Run Spotify search if credentials work; otherwise iTunes (real titles, no LLM).
 */
async function resolveTrackFromSearchQuery(spotifySearchQuery) {
    const q = String(spotifySearchQuery || '').trim();
    if (!q) throw new Error('Empty music search query from model.');
    if (hasSpotifyCredentials()) {
        try {
            const track = await spotifyApiSearchFirstTrack(q);
            return { track, usedQuery: q, source: 'spotify' };
        } catch (e) {
            console.warn('slimemytaste: Spotify resolution failed, using iTunes:', e && e.message);
        }
    }
    const track = await itunesSearchFirstTrack(q);
    return { track, usedQuery: q, source: 'itunes' };
}

/** Prefer a track whose primary artist matches the curator pick (from allowed list). */
async function resolveTrackForCurator(rawCuratorPick, moodKeywords) {
    const canon = resolveCuratorArtistPick(rawCuratorPick);
    const kw = String(moodKeywords || '').trim();
    const attempts = [
        buildSpotifySearchQueryForCurator(canon, kw),
        `${canon.replace(/\*/g, '')} ${kw}`.trim(),
        canon
    ];
    for (const q of attempts) {
        try {
            const r = await resolveTrackFromSearchQuery(q);
            if (trackMatchesCuratorPick(r.track, canon)) {
                return { ...r, usedQuery: q, curatorArtist: canon };
            }
        } catch (e) {
            console.warn('slimemytaste: curator track attempt failed:', q, e && e.message);
        }
    }
    const fallback = await resolveTrackFromSearchQuery(attempts[0]);
    return { ...fallback, usedQuery: attempts[0], curatorArtist: canon };
}

function buildYoutubeResultsUrl(searchQuery) {
    const q = String(searchQuery || '').trim() || 'visual art';
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
}

function buildStep2UserTask(entryText, track, step1, meta) {
    const trackFacts = JSON.stringify(
        {
            name: track.name,
            artists: (track.artists || []).map((a) => ({ name: a.name })),
            album: track.album?.name || null,
            preview_url: track.preview_url || null
        },
        null,
        0
    );
    const src = meta?.source || 'api';
    const used = meta?.usedQuery || '';
    const extra = meta?.extraNote ? `\n${meta.extraNote}\n` : '';
    return `${extra}Journal:
---
${entryText}
---

Real track returned by ${src} search (query: "${used}"):
${trackFacts}

Step-1 design philosophy (from DESIGN PHILOSOPHY UNIVERSE):
- philosophy: name="${step1.philosophy?.name || ''}" definition="${String(step1.philosophy?.definition || '')
        .replace(/"/g, "'")
        .replace(/\r?\n/g, ' ')
        .slice(0, 220)}" exploreUrl="${step1.philosophy?.exploreUrl || ''}"

Step-1 interactive experience (one of the five allowed sources only):
- interactive: siteName="${step1.interactive?.siteName || ''}" experienceName="${String(step1.interactive?.experienceName || '')
        .replace(/"/g, "'")
        .replace(/\r?\n/g, ' ')
        .slice(0, 220)}" url="${step1.interactive?.url || ''}" instruction="${String(step1.interactive?.instruction || '')
        .replace(/"/g, "'")
        .replace(/\r?\n/g, ' ')
        .slice(0, 160)}"`;
}

function packPhilosophy(step1Ph, step2Reason, scoreNum) {
    const sc = Number(scoreNum);
    const ph = {
        name: String(step1Ph?.name || '').trim(),
        definition: String(step1Ph?.definition || '').trim(),
        reason: String(step2Reason || '').trim(),
        exploreUrl: String(step1Ph?.exploreUrl || '').trim(),
        matchScore: Number.isFinite(sc) ? sc : null
    };
    coercePhilosophyExploreUrl(ph);
    return ph;
}

function packInteractive(step1Ix, step2Reason, scoreNum) {
    const sc = Number(scoreNum);
    const ix = {
        siteName: String(step1Ix?.siteName || '').trim(),
        experienceName: String(step1Ix?.experienceName || '').trim(),
        reason: String(step2Reason || '').trim(),
        url: String(step1Ix?.url || '').trim(),
        instruction: String(step1Ix?.instruction || '').trim(),
        matchScore: Number.isFinite(sc) ? sc : null
    };
    if (ix.url && urlPassesInteractiveAllowlist(ix.url)) {
        try {
            ix.url = canonicalizeInteractiveUrlString(ix.url);
        } catch {
            /* keep */
        }
    }
    return ix;
}

function buildRecFromPipeline(step1, track, step2, usedSpotifyQuery, curatorCanonical) {
    const artistName = track.artists?.[0]?.name || 'Unknown';
    const songTitle = track.name || '—';
    const spotifyOpen =
        track.external_urls?.spotify ||
        `https://open.spotify.com/search/${encodeURIComponent(`${artistName} ${songTitle}`)}`;
    const listenQ = `${artistName} ${songTitle}`.trim();
    const mScore = Number(step2.musicMatchScore);
    const phs = Number(step2.philosophyMatchScore);
    const ixs = Number(step2.interactiveMatchScore);
    const rec = {
        primaryEmotion: step1.primaryEmotion || '',
        artist: {
            name: artistName,
            song: songTitle,
            reason: String(step2.artistReason || '').trim(),
            matchScore: Number.isFinite(mScore) ? mScore : null,
            searchUrl: spotifyOpen,
            spotifySearchQuery: usedSpotifyQuery,
            curatorArtistPick: curatorCanonical || '',
            songYoutubeUrl: buildYoutubeResultsUrl(listenQ),
            songSoundcloudUrl: `https://soundcloud.com/search/sounds?q=${encodeURIComponent(listenQ)}`,
            albumCover: track.album?.images?.[0]?.url || null
        },
        philosophy: packPhilosophy(step1.philosophy, step2.philosophyReason, phs),
        interactive: packInteractive(step1.interactive, step2.interactiveReason, ixs),
        searchTrails: Array.isArray(step1.searchTrails) ? step1.searchTrails : [],
        searchUrls: []
    };
    const trails = rec.searchTrails.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 3);
    rec.searchTrails = trails;
    rec.searchUrls = trails.length
        ? trails.map((t) => `https://www.google.com/search?q=${encodeURIComponent(t)}`)
        : [];
    return normalizeRecommendationUrls(rec);
}

const WORKSPACE_BOARD_ID = 'default';

function workspaceDoc(uid) {
    return doc(db, 'users', uid, 'boards', WORKSPACE_BOARD_ID);
}

function frameEntryDoc(uid, frameId) {
    return doc(db, 'users', uid, 'boards', WORKSPACE_BOARD_ID, 'frames', frameId);
}

function framesCollection(uid) {
    return collection(db, 'users', uid, 'boards', WORKSPACE_BOARD_ID, 'frames');
}

/** Heart saves — under same workspace doc as frames (Firestore rules must allow this subcollection). */
function favoritesCollection(uid) {
    return collection(db, 'users', uid, 'boards', WORKSPACE_BOARD_ID, 'favorites');
}

function favoriteDoc(uid, favoriteId) {
    return doc(db, 'users', uid, 'boards', WORKSPACE_BOARD_ID, 'favorites', favoriteId);
}

function truncSnippet(s, max) {
    const t = String(s || '');
    return t.length <= max ? t : `${t.slice(0, max)}…`;
}

async function ensureAuthPersistence() {
    const tiers = [
        ['local', browserLocalPersistence],
        ['session', browserSessionPersistence],
        ['memory', inMemoryPersistence]
    ];
    for (const [name, persistence] of tiers) {
        try {
            await setPersistence(auth, persistence);
            console.log('slimemytaste: auth persistence →', name);
            return;
        } catch (e) {
            console.warn('slimemytaste: persistence failed (' + name + '):', e && (e.code || e.message));
        }
    }
}

function stashJournalSnapshotsBeforeHistory() {
    const canvas = document.getElementById('canvas');
    if (!canvas) return;
    canvas.querySelectorAll('.motif-frame').forEach((fr) => {
        const ta = fr.querySelector('.journal-entry-textarea');
        if (ta) fr.setAttribute('data-journal-snapshot', encodeURIComponent(ta.value));
    });
}

function restoreJournalSnapshotsAfterInnerHtml() {
    const canvas = document.getElementById('canvas');
    if (!canvas) return;
    canvas.querySelectorAll('.motif-frame[data-journal-snapshot]').forEach((fr) => {
        const raw = fr.getAttribute('data-journal-snapshot');
        const ta = fr.querySelector('.journal-entry-textarea');
        if (ta && raw) {
            try {
                ta.value = decodeURIComponent(raw);
            } catch {
                /* ignore */
            }
        }
    });
}

function extractGroqAssistantText(data) {
    const c = data?.choices?.[0]?.message?.content;
    return typeof c === 'string' ? c : '';
}

function parseVibeJsonFromResponse(data) {
    const text = extractGroqAssistantText(data);
    const clean = String(text)
        .replace(/^\uFEFF/, '')
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();
    try {
        return JSON.parse(clean);
    } catch (firstErr) {
        const start = clean.indexOf('{');
        const end = clean.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return JSON.parse(clean.slice(start, end + 1));
        }
        throw firstErr;
    }
}

const initApp = async () => {
    try {
        console.log('slimemytaste: Starting journal build…');
        const boardContainer = document.getElementById('board-container');
        const canvas = document.getElementById('canvas');
        const landingPage = document.getElementById('landing-page');
        const userIconBtn = document.querySelector('.login-trigger');
        const saveCloudBtn = document.getElementById('save-cloud-btn');
        const signupBtn = document.getElementById('signup-google-btn');
        const loginBtn = document.getElementById('login-google-btn');

        if (!boardContainer || !canvas || !landingPage) {
            throw new Error('Missing board DOM (#board-container, #canvas, or #landing-page).');
        }

        await ensureAuthPersistence();
        try {
            await getRedirectResult(auth);
        } catch (err) {
            const c = err && err.code;
            if (c && c !== 'auth/popup-closed-by-user' && c !== 'auth/cancelled-popup-request') {
                console.warn('[slimemytaste] getRedirectResult:', c, err.message || err);
            }
        }
        if (typeof auth.authStateReady === 'function') {
            await auth.authStateReady();
        }

        let groqEditOpen = false;
        const groqKeyOverlay = document.getElementById('groq-key-overlay');
        const groqKeyInput = document.getElementById('groq-key-input');
        const groqKeySaveBtn = document.getElementById('groq-key-save-btn');
        const groqKeyCancelBtn = document.getElementById('groq-key-cancel-btn');
        const groqKeyError = document.getElementById('groq-key-error');
        const groqKeySettingsBtn = document.getElementById('groq-key-settings-btn');
        const spotifyClientIdInput = document.getElementById('spotify-client-id-input');
        const spotifyClientSecretInput = document.getElementById('spotify-client-secret-input');

        function setGroqKeyError(msg) {
            if (!groqKeyError) return;
            if (msg) {
                groqKeyError.textContent = msg;
                groqKeyError.classList.remove('hidden');
            } else {
                groqKeyError.textContent = '';
                groqKeyError.classList.add('hidden');
            }
        }

        function syncGroqKeyToolbar() {
            if (!groqKeySettingsBtn) return;
            groqKeySettingsBtn.style.display = auth.currentUser ? 'flex' : 'none';
        }

        function applyGroqOverlayState() {
            if (!groqKeyOverlay) return;
            const hasKey = !!getGroqApiKey();
            const needsBlocking = !!(auth.currentUser && !hasKey);
            const show = needsBlocking || groqEditOpen;
            groqKeyOverlay.classList.toggle('hidden', !show);
            groqKeyOverlay.setAttribute('aria-hidden', show ? 'false' : 'true');
            if (groqKeyCancelBtn) {
                const showCancel = !!(groqEditOpen && auth.currentUser && hasKey);
                groqKeyCancelBtn.classList.toggle('hidden', !showCancel);
            }
        }

        function openGroqKeyEditor() {
            groqEditOpen = true;
            if (groqKeyInput) groqKeyInput.value = '';
            setGroqKeyError('');
            applyGroqOverlayState();
            groqKeyInput?.focus();
        }

        if (groqKeySaveBtn && groqKeyInput) {
            groqKeySaveBtn.addEventListener('click', () => {
                const raw = groqKeyInput.value.trim();
                if (!raw) {
                    setGroqKeyError('Paste your Groq API key to continue.');
                    return;
                }
                if (!saveGroqApiKey(raw)) {
                    setGroqKeyError('Could not save key (browser storage blocked?).');
                    return;
                }
                const sid = spotifyClientIdInput ? String(spotifyClientIdInput.value || '').trim() : '';
                const sec = spotifyClientSecretInput ? String(spotifyClientSecretInput.value || '').trim() : '';
                saveSpotifyCredentials(sid, sec);
                groqEditOpen = false;
                setGroqKeyError('');
                applyGroqOverlayState();
                syncGroqKeyToolbar();
            });
            groqKeyInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    groqKeySaveBtn.click();
                }
            });
        }
        if (groqKeyCancelBtn) {
            groqKeyCancelBtn.addEventListener('click', () => {
                groqEditOpen = false;
                if (groqKeyInput) groqKeyInput.value = '';
                setGroqKeyError('');
                applyGroqOverlayState();
            });
        }
        if (groqKeySettingsBtn) {
            groqKeySettingsBtn.addEventListener('click', () => openGroqKeyEditor());
        }

        let cloudSaveTimer = null;

        async function persistFrameEntriesToCloud() {
            if (!auth.currentUser) return;
            const uid = auth.currentUser.uid;
            const frames = canvas.querySelectorAll('.motif-frame');
            for (const fr of frames) {
                const fid = fr.id;
                if (!fid) continue;
                const ta = fr.querySelector('.journal-entry-textarea');
                const entry = ta ? ta.value.trim() : '';
                await setDoc(frameEntryDoc(uid, fid), { entry, updatedAt: new Date() }, { merge: true });
            }
        }

        async function persistBoardToCloud({ silent = false } = {}) {
            if (!auth.currentUser) return;
            document.querySelectorAll('#canvas input').forEach((inp) => inp.setAttribute('value', inp.value));
            stashJournalSnapshotsBeforeHistory();
            let ghostHtml = '';
            const ghost = document.getElementById('ghost-frame');
            if (ghost && ghost.parentNode === canvas) {
                canvas.removeChild(ghost);
                ghostHtml = ghost.outerHTML;
            }
            try {
                await setDoc(
                    workspaceDoc(auth.currentUser.uid),
                    {
                        canvasHTML: canvas.innerHTML,
                        updatedAt: new Date()
                    },
                    { merge: true }
                );
                await persistFrameEntriesToCloud();
            } finally {
                if (ghostHtml) canvas.innerHTML = ghostHtml + canvas.innerHTML;
                restoreJournalSnapshotsAfterInnerHtml();
            }
        }

        async function hydrateFrameEntriesFromFirestore(uid) {
            try {
                const snap = await getDocs(framesCollection(uid));
                snap.forEach((d) => {
                    const fr = document.getElementById(d.id);
                    const ta = fr && fr.querySelector('.journal-entry-textarea');
                    if (ta && typeof d.data().entry === 'string') ta.value = d.data().entry;
                });
            } catch (e) {
                console.warn('slimemytaste: could not load frame entries:', e && (e.code || e.message));
            }
        }

        async function loadWorkspaceForUser(uid) {
            let snap = await getDoc(workspaceDoc(uid));
            let exists = typeof snap.exists === 'function' ? snap.exists() : snap.exists;
            let data = snap.data();
            if (!exists || !data?.canvasHTML) {
                try {
                    const legacy = await getDoc(doc(db, 'boards', uid));
                    const legEx = typeof legacy.exists === 'function' ? legacy.exists() : legacy.exists;
                    const legData = legacy.data();
                    if (legEx && legData?.canvasHTML) {
                        await setDoc(
                            workspaceDoc(uid),
                            { canvasHTML: legData.canvasHTML, updatedAt: new Date(), migratedFromLegacyBoardsDoc: true },
                            { merge: true }
                        );
                        snap = await getDoc(workspaceDoc(uid));
                        exists = typeof snap.exists === 'function' ? snap.exists() : snap.exists;
                        data = snap.data();
                    }
                } catch {
                    /* legacy path may be denied by new rules */
                }
            }
            if (exists && data && data.canvasHTML) {
                const temp = document.createElement('div');
                temp.innerHTML = data.canvasHTML;
                const ghost = document.getElementById('ghost-frame');
                if (ghost) temp.prepend(ghost);
                canvas.innerHTML = temp.innerHTML;
                document.querySelectorAll('#canvas input').forEach((inp) => {
                    if (inp.hasAttribute('value')) inp.value = inp.getAttribute('value');
                });
                restoreJournalSnapshotsAfterInnerHtml();
                canvas.querySelectorAll('.motif-board').forEach((b) => b.remove());
                await hydrateFrameEntriesFromFirestore(uid);
                wireAllJournalFrames();
            }
        }

        function scheduleCloudSave() {
            if (!auth.currentUser) return;
            if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
            cloudSaveTimer = setTimeout(() => {
                cloudSaveTimer = null;
                persistBoardToCloud({ silent: true }).catch((err) => console.warn('Auto-save:', err));
            }, 2800);
        }

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden' && auth.currentUser) {
                if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
                persistBoardToCloud({ silent: true }).catch(() => {});
            }
        });

        onAuthStateChanged(auth, async (user) => {
            console.log('Auth State Changed:', user ? 'Logged In' : 'Logged Out');
            if (user) {
                landingPage.classList.add('hidden');
                landingPage.style.display = 'none';
                if (userIconBtn) {
                    const av = user.photoURL;
                    userIconBtn.innerHTML = av
                        ? `<img src="${av}" alt="" referrerpolicy="no-referrer" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover;">`
                        : `<i class="fa-solid fa-user-check" style="font-size:16px;"></i>`;
                    userIconBtn.title = `Logged in as ${user.displayName || user.email || 'Google'} (click to sign out)`;
                }
                if (saveCloudBtn) saveCloudBtn.style.display = 'block';
                try {
                    await setDoc(
                        workspaceDoc(user.uid),
                        {
                            userProfile: {
                                displayName: user.displayName || null,
                                email: user.email || null,
                                photoURL: user.photoURL || null,
                                lastLoginAt: new Date().toISOString()
                            },
                            updatedAt: new Date()
                        },
                        { merge: true }
                    );
                    await loadWorkspaceForUser(user.uid);
                } catch (e) {
                    console.error('Load Error:', e);
                }
                syncGroqKeyToolbar();
                applyGroqOverlayState();
            } else {
                groqEditOpen = false;
                landingPage.classList.remove('hidden');
                landingPage.style.display = 'flex';
                if (userIconBtn) {
                    userIconBtn.innerHTML = `<i class="fa-solid fa-user"></i>`;
                    userIconBtn.title = 'Log in';
                }
                if (saveCloudBtn) saveCloudBtn.style.display = 'none';
                syncGroqKeyToolbar();
                applyGroqOverlayState();
            }
        });

        let isSigningIn = false;
        async function doGoogleSignIn(e) {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            if (isSigningIn) return;
            isSigningIn = true;
            try {
                await ensureAuthPersistence();
                const result = await signInWithPopup(auth, provider);
                if (result.user) {
                    landingPage.classList.add('hidden');
                    landingPage.style.display = 'none';
                }
            } catch (error) {
                const code = error && error.code;
                if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
                    try {
                        await ensureAuthPersistence();
                        await signInWithRedirect(auth, provider);
                    } catch (e2) {
                        alert('Login Error: ' + (e2.code || e2.message));
                    }
                } else {
                    alert('Login Error: ' + (code || error.message));
                }
            } finally {
                isSigningIn = false;
            }
        }

        if (signupBtn) signupBtn.addEventListener('click', doGoogleSignIn);
        if (loginBtn) loginBtn.addEventListener('click', doGoogleSignIn);
        if (userIconBtn) {
            userIconBtn.addEventListener('click', async (e) => {
                if (auth.currentUser) {
                    if (!confirm('Sign out? Your journal will be saved to the cloud first.')) return;
                    try {
                        await persistBoardToCloud({ silent: true });
                    } catch (err) {
                        console.warn('Save before sign-out:', err);
                    }
                    await signOut(auth);
                    location.reload();
                } else {
                    doGoogleSignIn(e);
                }
            });
        }

        const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
        /** Order: primary 70B-class, OSS fallback (Groq-recommended), fast instant. Never use deprecated llama-3.1-70b-versatile. */
        const GROQ_MODELS = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'];

        const GROQ_FETCH_TIMEOUT_MS = 75000;

        async function groqChatCompletion(fullPromptText, { temperature, max_tokens }) {
            const apiKey = getGroqApiKey();
            if (!apiKey) {
                throw new Error(
                    'Missing Groq API key. Sign in and paste your key in the Connect Groq dialog, or set window.MYMOTIF_GROQ_API_KEY for local dev.'
                );
            }
            let lastMessage = '';
            const maxAttempts = 4;
            for (const model of GROQ_MODELS) {
                for (let attempt = 0; attempt < maxAttempts; attempt++) {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), GROQ_FETCH_TIMEOUT_MS);
                    let response;
                    try {
                        response = await fetch(GROQ_CHAT_URL, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                Authorization: `Bearer ${apiKey}`
                            },
                            body: JSON.stringify({
                                model,
                                messages: [
                                    { role: 'system', content: GROQ_SYSTEM_PROMPT },
                                    { role: 'user', content: fullPromptText }
                                ],
                                temperature,
                                max_tokens
                            }),
                            signal: controller.signal
                        });
                    } catch (e) {
                        clearTimeout(timer);
                        lastMessage = e && e.name === 'AbortError' ? 'Request timed out.' : String(e.message || e);
                        break;
                    }
                    clearTimeout(timer);
                    const data = await response.json().catch(() => ({}));
                    const errBody = data.error?.message || '';
                    const modelBad =
                        response.status === 404 ||
                        /model.*not found|does not exist|invalid model|unknown model|decommissioned|no longer supported|deprecated/i.test(
                            errBody
                        );
                    if (modelBad) {
                        lastMessage = errBody || `HTTP ${response.status} (${model})`;
                        break;
                    }
                    if (response.ok && extractGroqAssistantText(data).trim()) return data;
                    lastMessage = errBody || `HTTP ${response.status}`;
                    const is429 =
                        response.status === 429 ||
                        /rate limit|too many requests|quota/i.test(lastMessage);
                    if (is429 && attempt < maxAttempts - 1) {
                        await new Promise((r) => setTimeout(r, 12000));
                        continue;
                    }
                    break;
                }
            }
            throw new Error(lastMessage || 'Groq request failed.');
        }

        function escapeHtml(s) {
            if (s == null) return '';
            return String(s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        /** --- Vibe panel (slide-in from right) --- */
        const vibeOverlay = document.createElement('div');
        vibeOverlay.id = 'vibe-panel-overlay';
        vibeOverlay.className = 'vibe-panel-overlay hidden';
        vibeOverlay.innerHTML = `
            <div class="vibe-panel-backdrop" data-vibe-close="1"></div>
            <aside class="vibe-panel-drawer" role="dialog" aria-modal="true" aria-label="slimemytaste">
                <div class="vibe-panel-header">
                    <h2 class="vibe-panel-title">turning you slime right now twin</h2>
                    <button type="button" class="vibe-panel-close icon-btn" title="Close" data-vibe-close="1"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="vibe-panel-body" id="vibe-panel-stage"></div>
                <p class="vibe-panel-footer-note">Sorry Twin, You Slime Now.</p>
            </aside>`;
        document.body.appendChild(vibeOverlay);

        const favoritesOverlay = document.createElement('div');
        favoritesOverlay.id = 'favorites-panel-overlay';
        favoritesOverlay.className = 'favorites-panel-overlay hidden';
        favoritesOverlay.innerHTML = `
            <div class="favorites-panel-backdrop" data-favorites-close="1"></div>
            <aside class="favorites-panel-drawer" role="dialog" aria-modal="true" aria-label="Favorites">
                <div class="favorites-panel-header">
                    <h2 class="favorites-panel-title">Favorites</h2>
                    <button type="button" class="icon-btn favorites-panel-close" data-favorites-close="1" title="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="favorites-panel-body" id="favorites-panel-body"></div>
            </aside>`;
        document.body.appendChild(favoritesOverlay);

        function formatFavoriteEntryHtml(it) {
            const snap = it.snapshot || {};
            const promptRaw = it.promptRecap || it.journalSnippet || '';
            const promptShown = escapeHtml(truncSnippet(promptRaw, 420));
            const metaBlock = promptRaw
                ? `<div class="favorites-doc-meta">
                    <p class="favorites-doc-row favorites-doc-prompt"><span class="favorites-doc-label">What you wrote</span> ${promptShown}</p>
                  </div>`
                : '';

            if (it.kind === 'philosophy') {
                const ph = snap;
                const title = escapeHtml(String(ph.name || '—'));
                const def = escapeHtml(truncSnippet(String(ph.definition || ''), 200));
                const reason = escapeHtml(truncSnippet(String(ph.reason || ''), 400));
                const ex = String(ph.exploreUrl || '').trim();
                const exploreLink = ex
                    ? `<p class="favorites-links"><a href="${escapeHtml(ex)}" target="_blank" rel="noopener noreferrer">Explore</a></p>`
                    : '';
                return `<article class="favorites-entry favorites-entry--philosophy">
                    ${metaBlock}
                    <div class="favorites-entry-top">
                        <span class="favorites-entry-kind">Design philosophy</span>
                        <button type="button" class="favorites-delete-btn icon-btn" data-delete-favorite="${escapeHtml(it.id)}" title="Remove"><i class="fa-solid fa-trash"></i></button>
                    </div>
                    <h4 class="favorites-primary-line">${title}</h4>
                    ${def ? `<p class="favorites-entry-note">${def}</p>` : ''}
                    ${reason ? `<p class="favorites-entry-note">${reason}</p>` : ''}
                    ${exploreLink}
                </article>`;
            }

            if (it.kind === 'interactive') {
                const ix = snap;
                const site = String(ix.siteName || '').trim();
                const exp = String(ix.experienceName || '').trim();
                const head = escapeHtml([site, exp].filter(Boolean).join(' — ') || 'Interactive');
                const reason = escapeHtml(truncSnippet(String(ix.reason || ''), 400));
                const inst = escapeHtml(truncSnippet(String(ix.instruction || ''), 160));
                const url = String(ix.url || '').trim();
                const openLink = url
                    ? `<p class="favorites-links"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open it</a></p>`
                    : '';
                return `<article class="favorites-entry favorites-entry--interactive">
                    ${metaBlock}
                    <div class="favorites-entry-top">
                        <span class="favorites-entry-kind">Interactive</span>
                        <button type="button" class="favorites-delete-btn icon-btn" data-delete-favorite="${escapeHtml(it.id)}" title="Remove"><i class="fa-solid fa-trash"></i></button>
                    </div>
                    <h4 class="favorites-primary-line">${head}</h4>
                    ${reason ? `<p class="favorites-entry-note">${reason}</p>` : ''}
                    ${inst ? `<p class="favorites-entry-note">${inst}</p>` : ''}
                    ${openLink}
                </article>`;
            }

            if (it.kind === 'artist') {
                const song = escapeHtml(String(snap.song || '—'));
                const artist = escapeHtml(String(snap.name || ''));
                const y = snap.songYoutubeUrl || '';
                const sp = snap.searchUrl || '';
                const sc = snap.songSoundcloudUrl || '';
                const parts = [];
                if (y) parts.push(`<a href="${escapeHtml(y)}" target="_blank" rel="noopener noreferrer">YouTube</a>`);
                if (sp) parts.push(`<a href="${escapeHtml(sp)}" target="_blank" rel="noopener noreferrer">Spotify</a>`);
                if (sc) parts.push(`<a href="${escapeHtml(sc)}" target="_blank" rel="noopener noreferrer">SoundCloud</a>`);
                const streams = parts.length ? `<p class="favorites-links">${parts.join(' · ')}</p>` : '';
                return `<article class="favorites-entry favorites-entry--music">
                    ${metaBlock}
                    <div class="favorites-entry-top">
                        <span class="favorites-entry-kind">Music</span>
                        <button type="button" class="favorites-delete-btn icon-btn" data-delete-favorite="${escapeHtml(it.id)}" title="Remove"><i class="fa-solid fa-trash"></i></button>
                    </div>
                    <h4 class="favorites-primary-line"><span class="favorites-song-title">${song}</span><span class="favorites-by"> — ${artist}</span></h4>
                    ${streams}
                </article>`;
            }

            if (it.kind === 'style') {
                const se = snap;
                const label = escapeHtml(String(se.styleLabel || '—'));
                const scene = String(se.traditionOrScene || '').trim();
                const url = String(se.exploreUrl || '').trim();
                const why = escapeHtml(truncSnippet(String(se.whyThisFits || ''), 360));
                const reason = escapeHtml(truncSnippet(String(se.reason || ''), 240));
                const exploreLink = url
                    ? `<p class="favorites-links"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Search &amp; explore</a></p>`
                    : '';
                return `<article class="favorites-entry favorites-entry--style">
                    ${metaBlock}
                    <div class="favorites-entry-top">
                        <span class="favorites-entry-kind">Style to explore</span>
                        <button type="button" class="favorites-delete-btn icon-btn" data-delete-favorite="${escapeHtml(it.id)}" title="Remove"><i class="fa-solid fa-trash"></i></button>
                    </div>
                    <h4 class="favorites-primary-line">${label}</h4>
                    ${scene ? `<p class="favorites-entry-note">${escapeHtml(scene)}</p>` : ''}
                    ${why ? `<p class="favorites-entry-note">${why}</p>` : ''}
                    ${reason ? `<p class="favorites-entry-note">${reason}</p>` : ''}
                    ${exploreLink}
                </article>`;
            }

            const fu = String(snap.findUrl || '').trim();
            const artName = String(snap.name || '—');
            const artType = String(snap.type || 'Art');
            const titleHtml = fu
                ? `<h4 class="favorites-primary-line"><a class="favorites-title-link" href="${escapeHtml(fu)}" target="_blank" rel="noopener noreferrer">${escapeHtml(artName)}</a> <span class="favorites-art-type">(${escapeHtml(artType)})</span></h4>`
                : `<h4 class="favorites-primary-line">${escapeHtml(artName)} <span class="favorites-art-type">(${escapeHtml(artType)})</span></h4>`;
            const reasonShort = escapeHtml(truncSnippet(String(snap.reason || ''), 320));

            return `<article class="favorites-entry favorites-entry--art">
                ${metaBlock}
                <div class="favorites-entry-top">
                    <span class="favorites-entry-kind">Art</span>
                    <button type="button" class="favorites-delete-btn icon-btn" data-delete-favorite="${escapeHtml(it.id)}" title="Remove"><i class="fa-solid fa-trash"></i></button>
                </div>
                ${titleHtml}
                ${reasonShort ? `<p class="favorites-entry-note">${reasonShort}</p>` : ''}
            </article>`;
        }

        async function renderFavoritesPanelContent() {
            const body = document.getElementById('favorites-panel-body');
            if (!body) return;
            const user = auth.currentUser;
            if (!user) {
                body.innerHTML = '<p class="favorites-empty">Sign in to save and view favorites.</p>';
                return;
            }
            body.innerHTML = '<div class="favorites-loading"><i class="fa-solid fa-spinner fa-spin"></i><span> Loading…</span></div>';
            try {
                const snap = await getDocs(favoritesCollection(user.uid));
                const items = [];
                snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
                items.sort((a, b) => {
                    const ta = a.savedAt?.toMillis ? a.savedAt.toMillis() : 0;
                    const tb = b.savedAt?.toMillis ? b.savedAt.toMillis() : 0;
                    return tb - ta;
                });
                const byMood = new Map();
                for (const it of items) {
                    const m = String(it.mood || 'Uncategorized').trim() || 'Uncategorized';
                    if (!byMood.has(m)) byMood.set(m, []);
                    byMood.get(m).push(it);
                }
                const moods = [...byMood.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
                if (moods.length === 0) {
                    body.innerHTML =
                        '<p class="favorites-empty">No favorites yet. Use &ldquo;you need to see ts&rdquo; on a journal, then tap the heart on a suggestion.</p>';
                    return;
                }
                let html =
                    '<p class="favorites-doc-intro">Saved by <strong>mood</strong> — each card shows what you wrote that session and what you saved (music, design philosophy, or interactive experience).</p><div class="favorites-doc">';
                for (const mood of moods) {
                    html += `<h3 class="favorites-mood-heading">${escapeHtml(mood)}</h3>`;
                    for (const it of byMood.get(mood)) {
                        html += formatFavoriteEntryHtml(it);
                    }
                }
                html += '</div>';
                body.innerHTML = html;
                body.querySelectorAll('[data-delete-favorite]').forEach((btn) => {
                    btn.addEventListener('click', async () => {
                        const id = btn.getAttribute('data-delete-favorite');
                        if (!id || !auth.currentUser) return;
                        btn.disabled = true;
                        try {
                            await deleteDoc(favoriteDoc(auth.currentUser.uid, id));
                            await renderFavoritesPanelContent();
                        } catch (err) {
                            alert(err.message || String(err));
                            btn.disabled = false;
                        }
                    });
                });
            } catch (e) {
                body.innerHTML = `<p class="favorites-error">${escapeHtml(e.message || String(e))}</p>`;
            }
        }

        function openFavoritesPanel() {
            favoritesOverlay.classList.remove('hidden');
            void renderFavoritesPanelContent();
        }

        function closeFavoritesPanel() {
            favoritesOverlay.classList.add('hidden');
        }

        favoritesOverlay.addEventListener('click', (e) => {
            if (e.target.closest('[data-favorites-close="1"]')) closeFavoritesPanel();
        });

        const favoritesOpenBtn = document.getElementById('favorites-open-btn');
        if (favoritesOpenBtn) favoritesOpenBtn.addEventListener('click', () => openFavoritesPanel());

        const vibeStage = vibeOverlay.querySelector('#vibe-panel-stage');
        vibeOverlay.addEventListener('click', (e) => {
            if (e.target.closest('[data-vibe-close="1"]')) closeVibePanel();
        });

        const vibeState = {
            frame: null,
            entry: '',
            primaryEmotion: '',
            selected: [],
            rec: null,
            historyArtist: [],
            historyPhilosophy: [],
            historyInteractive: []
        };

        function openVibePanel() {
            vibeOverlay.classList.remove('hidden');
        }

        function closeVibePanel() {
            vibeOverlay.classList.add('hidden');
            vibeStage.innerHTML = '';
        }

        function setVibeStage(html) {
            vibeStage.innerHTML = html;
        }

        async function saveFavoriteFromVibe(kind) {
            const user = auth.currentUser;
            if (!user) {
                alert('Sign in to save favorites.');
                return;
            }
            const r = vibeState.rec;
            if (!r || typeof r !== 'object') return;
            let snapshot = null;
            if (kind === 'artist') snapshot = r.artist ? JSON.parse(JSON.stringify(r.artist)) : null;
            else if (kind === 'philosophy') snapshot = r.philosophy ? JSON.parse(JSON.stringify(r.philosophy)) : null;
            else if (kind === 'interactive') snapshot = r.interactive ? JSON.parse(JSON.stringify(r.interactive)) : null;
            if (!snapshot) return;
            const mood = String(vibeState.primaryEmotion || '').trim() || 'Uncategorized';
            try {
                await addDoc(favoritesCollection(user.uid), {
                    mood,
                    kind,
                    promptRecap: String(vibeState.entry || '').slice(0, 500),
                    snapshot,
                    savedAt: serverTimestamp()
                });
                const btn = vibeStage.querySelector(`[data-vibe-favorite="${kind}"]`);
                if (btn) {
                    btn.innerHTML = '<i class="fa-solid fa-heart" aria-hidden="true"></i>';
                    btn.classList.add('vibe-favorite-btn--saved');
                    btn.title = 'Saved to favorites';
                }
            } catch (err) {
                const code = err && err.code;
                const msg = err && err.message ? err.message : String(err);
                if (code === 'permission-denied' || /insufficient permissions/i.test(msg)) {
                    alert(
                        'Could not save to the cloud (permission denied). Deploy the latest Firestore rules from this project:\n\nfirebase deploy --only firestore:rules'
                    );
                } else {
                    alert(msg);
                }
            }
        }

        /** Truncate long reasons in reshuffle payload to save input tokens. */
        function compactVibeRecForPrompt(rec, maxReasonChars = 320) {
            if (!rec || typeof rec !== 'object') return '{}';
            const cut = (s) => {
                const t = String(s ?? '');
                return t.length <= maxReasonChars ? t : `${t.slice(0, maxReasonChars)}…`;
            };
            const a = rec.artist;
            const ph = rec.philosophy;
            const ix = rec.interactive;
            return JSON.stringify({
                artist: a
                    ? {
                          name: a.name,
                          song: a.song,
                          albumCover: a.albumCover,
                          songYoutubeUrl: a.songYoutubeUrl,
                          songSoundcloudUrl: a.songSoundcloudUrl,
                          reason: cut(a.reason),
                          searchUrl: a.searchUrl,
                          matchScore: a.matchScore,
                          spotifySearchQuery: a.spotifySearchQuery,
                          curatorArtistPick: a.curatorArtistPick
                      }
                    : undefined,
                philosophy: ph
                    ? {
                          name: ph.name,
                          definition: ph.definition,
                          reason: cut(ph.reason),
                          exploreUrl: ph.exploreUrl,
                          matchScore: ph.matchScore
                      }
                    : undefined,
                interactive: ix
                    ? {
                          siteName: ix.siteName,
                          experienceName: ix.experienceName,
                          reason: cut(ix.reason),
                          url: ix.url,
                          instruction: ix.instruction,
                          matchScore: ix.matchScore
                      }
                    : undefined,
                searchTrails: rec.searchTrails,
                searchUrls: rec.searchUrls
            });
        }

        async function runExplainStep(entryText, track, step1, meta) {
            const step2Task = buildStep2UserTask(entryText, track, step1, meta);
            const data2 = await groqChatCompletion(`${step2Task}\n\n${buildVibeStep2OutputContract()}`, {
                temperature: 0.72,
                max_tokens: 2048
            });
            return parseVibeJsonFromResponse(data2);
        }

        async function runVibeJournalToRecommendations(entryText) {
            const session = vibeSessionStamp();
            const step1Task = `SESSION: ${session}

Journal:
---
${entryText}
---`;

            const data1 = await groqChatCompletion(`${step1Task}\n\n${buildVibeStep1OutputContract()}`, {
                temperature: 0.78,
                max_tokens: 2048
            });
            const step1 = parseVibeJsonFromResponse(data1);
            if (!step1 || typeof step1 !== 'object') throw new Error('Invalid step-1 model response.');
            const canon = resolveCuratorArtistPick(step1.curatorArtistPick);
            const mood = String(step1.spotifyMoodKeywords ?? '').trim();
            const phRaw = step1.philosophy;
            if (!phRaw || typeof phRaw !== 'object') {
                throw new Error('philosophy is required (design philosophy card). Try again.');
            }
            if (!String(phRaw.name || '').trim()) {
                throw new Error('philosophy.name is required. Try again.');
            }
            if (!String(phRaw.definition || '').trim()) {
                throw new Error('philosophy.definition is required (one line). Try again.');
            }
            const ixRaw = step1.interactive;
            if (!ixRaw || typeof ixRaw !== 'object') {
                throw new Error('interactive is required (interactive experience card). Try again.');
            }
            if (!String(ixRaw.siteName || '').trim()) {
                throw new Error('interactive.siteName is required. Try again.');
            }
            if (!String(ixRaw.experienceName || '').trim()) {
                throw new Error('interactive.experienceName is required. Try again.');
            }
            const ixUrl = String(ixRaw.url || '').trim();
            if (!ixUrl || !urlPassesInteractiveAllowlist(ixUrl)) {
                throw new Error(
                    'interactive.url must be one of the five allowed sources (neal.fun, theuselessweb.com, patatap.com, itch.io tag URL, radio.garden). Try again.'
                );
            }
            if (!String(ixRaw.instruction || '').trim()) {
                throw new Error('interactive.instruction is required (what to do on the site). Try again.');
            }

            let { track, usedQuery, source } = await resolveTrackForCurator(step1.curatorArtistPick, mood);
            let step2 = await runExplainStep(entryText, track, step1, { source, usedQuery });

            if (Number(step2.musicMatchScore) < 6 && String(step2.refinedSpotifyQuery || '').trim()) {
                const refinedMood = String(step2.refinedSpotifyQuery).trim();
                const second = await resolveTrackForCurator(step1.curatorArtistPick, refinedMood);
                track = second.track;
                usedQuery = second.usedQuery;
                source = second.source;
                const retryTask = buildStep2UserTask(entryText, track, step1, {
                    source,
                    usedQuery,
                    extraNote:
                        'After ONE refined mood search (same curator artist). Set refinedSpotifyQuery to null.'
                });
                const dataRetry = await groqChatCompletion(
                    `Note: Final pass after refined search. Set refinedSpotifyQuery to null.\n\n${retryTask}\n\n${buildVibeStep2OutputContract()}`,
                    {
                        temperature: 0.72,
                        max_tokens: 2048
                    }
                );
                step2 = parseVibeJsonFromResponse(dataRetry);
            }

            return buildRecFromPipeline(step1, track, step2, usedQuery, canon);
        }

        async function runVibeReshuffle(kind, avoidName) {
            const entryText = vibeState.entry;
            const rec = vibeState.rec;
            if (!rec || typeof rec !== 'object') return;

            const philosophySlotToStep1 = (slot) => ({
                name: slot?.name,
                definition: slot?.definition,
                exploreUrl: slot?.exploreUrl
            });
            const interactiveSlotToStep1 = (slot) => ({
                siteName: slot?.siteName,
                experienceName: slot?.experienceName,
                url: slot?.url,
                instruction: slot?.instruction
            });

            if (kind === 'artist') {
                const session = vibeSessionStamp();
                const allowed = CURATOR_ARTISTS.join(', ');
                const userP = `SESSION: ${session}

ALLOWED ARTISTS (pick exactly one string from this list when returning curatorArtistPick):
${allowed}

Journal:
---
${entryText}
---

Previous curatorArtistPick: ${rec.artist?.curatorArtistPick || ''}
Previous search used: ${rec.artist?.spotifySearchQuery || ''}

Pick a **different** artist from the allowed list + new mood keywords. Avoid mimicking: "${avoidName}"`;

                const data = await groqChatCompletion(`${userP}\n\n${buildVibeReshuffleMusicContract()}`, {
                    temperature: 0.9,
                    max_tokens: 512
                });
                const j = parseVibeJsonFromResponse(data);
                const newPickRaw = j.curatorArtistPick;
                const mood = String(j.spotifyMoodKeywords ?? '').trim();
                if (!newPickRaw || !mood) throw new Error('Reshuffle needs curatorArtistPick and spotifyMoodKeywords.');
                const newCanon = resolveCuratorArtistPick(newPickRaw);

                let { track, usedQuery, source } = await resolveTrackForCurator(newPickRaw, mood);
                const step1Preserve = {
                    primaryEmotion: vibeState.primaryEmotion,
                    philosophy: philosophySlotToStep1(rec.philosophy),
                    interactive: interactiveSlotToStep1(rec.interactive),
                    searchTrails: rec.searchTrails
                };
                let step2 = await runExplainStep(entryText, track, step1Preserve, { source, usedQuery });
                if (Number(step2.musicMatchScore) < 6 && String(step2.refinedSpotifyQuery || '').trim()) {
                    const refinedMood = String(step2.refinedSpotifyQuery).trim();
                    const second = await resolveTrackForCurator(newPickRaw, refinedMood);
                    track = second.track;
                    usedQuery = second.usedQuery;
                    source = second.source;
                    const retryTask = buildStep2UserTask(entryText, track, step1Preserve, {
                        source,
                        usedQuery,
                        extraNote:
                            'Refined mood pass (final). Set refinedSpotifyQuery to null in your JSON output.'
                    });
                    const dataRetry = await groqChatCompletion(
                        `Note: Final pass after refined search. Set refinedSpotifyQuery to null.\n\n${retryTask}\n\n${buildVibeStep2OutputContract()}`,
                        {
                            temperature: 0.72,
                            max_tokens: 2048
                        }
                    );
                    step2 = parseVibeJsonFromResponse(dataRetry);
                }
                vibeState.rec = buildRecFromPipeline(step1Preserve, track, step2, usedQuery, newCanon);
                return;
            }

            if (kind === 'interactive') {
                const session = vibeSessionStamp();
                const prevSlot = rec.interactive || {};
                const phRef = rec.philosophy || {};
                const userP = `SESSION: ${session}

Journal:
---
${entryText}
---

Based on the emotional details of this journal entry, pick ONE of these five sources: neal.fun, theuselessweb.com, patatap.com, itch.io, or radio.garden. Choose the one whose energy matches the specific feeling in the entry. Construct a valid URL using only the formats provided in the system prompt. Quote exact phrases from the entry in the reason.

Pick a **different** source or URL than before when possible.
Previous site: ${prevSlot.siteName || ''}
Previous URL: ${prevSlot.url || ''}
Previous experienceName: ${String(prevSlot.experienceName || '').slice(0, 200)}
Other card is design philosophy (do not duplicate as the interactive pick): ${phRef.name || ''}
Avoid repeating this key: "${avoidName}"`;

                const data = await groqChatCompletion(`${userP}\n\n${buildVibeReshuffleInteractiveContract()}`, {
                    temperature: 0.88,
                    max_tokens: 1024
                });
                const j = parseVibeJsonFromResponse(data);
                const ix = j.interactive && typeof j.interactive === 'object' ? j.interactive : j;
                const url = String(ix.url || '').trim();
                if (!urlPassesInteractiveAllowlist(url)) {
                    throw new Error('Reshuffle returned a URL outside the five allowed sources.');
                }
                let canonUrl = url;
                try {
                    canonUrl = canonicalizeInteractiveUrlString(url);
                } catch {
                    /* keep */
                }
                rec.interactive = {
                    siteName: String(ix.siteName || '').trim(),
                    experienceName: String(ix.experienceName || '').trim(),
                    reason: String(ix.reason || '').trim(),
                    url: canonUrl,
                    instruction: String(ix.instruction || '').trim(),
                    matchScore: Number.isFinite(Number(j.interactiveMatchScore))
                        ? Number(j.interactiveMatchScore)
                        : Number.isFinite(Number(ix.interactiveMatchScore))
                          ? Number(ix.interactiveMatchScore)
                          : null
                };
                vibeState.rec = normalizeRecommendationUrls(rec);
                return;
            }

            if (kind !== 'philosophy') return;

            const session = vibeSessionStamp();
            const other = rec.interactive || {};
            const prevSlot = rec.philosophy || {};
            const userP = `SESSION: ${session}

Journal:
---
${entryText}
---

Based on the emotional details of this journal entry, select ONE design philosophy from your knowledge that captures the specific texture of what the user wrote — not the general theme but the precise feeling. Quote exact phrases from the entry in your reason.

Pick a **different** philosophy name than before.
Previous philosophy: ${prevSlot.name || ''}
Previous definition: ${String(prevSlot.definition || '').slice(0, 200)}
Other card is interactive (stay separate): ${other.siteName || ''} — ${other.experienceName || ''}
Avoid repeating: "${avoidName}"`;

            const data = await groqChatCompletion(`${userP}\n\n${buildVibeReshufflePhilosophyContract()}`, {
                temperature: 0.88,
                max_tokens: 1024
            });
            const j = parseVibeJsonFromResponse(data);
            const ph = j.philosophy && typeof j.philosophy === 'object' ? j.philosophy : j;
            const merged = {
                name: String(ph.name || '').trim(),
                definition: String(ph.definition || '').trim(),
                reason: String(ph.reason || '').trim(),
                exploreUrl: String(ph.exploreUrl || '').trim(),
                matchScore: Number.isFinite(Number(j.philosophyMatchScore))
                    ? Number(j.philosophyMatchScore)
                    : Number.isFinite(Number(ph.philosophyMatchScore))
                      ? Number(ph.philosophyMatchScore)
                      : null
            };
            coercePhilosophyExploreUrl(merged);
            rec.philosophy = { ...rec.philosophy, ...merged };
            vibeState.rec = normalizeRecommendationUrls(rec);
        }

        function cardSpinner() {
            return '<div class="vibe-card-spinner"><i class="fa-solid fa-spinner fa-spin"></i></div>';
        }

        function renderResultsStep() {
            const r = vibeState.rec || {};
            const a = r.artist || {};
            const ph = r.philosophy || {};
            const ix = r.interactive || {};
            const trails = Array.isArray(r.searchTrails) ? r.searchTrails : [];
            const urls = Array.isArray(r.searchUrls) ? r.searchUrls : [];
            const emo = vibeState.primaryEmotion ? `<p class="vibe-emotion-label"><em>${escapeHtml(vibeState.primaryEmotion)}</em></p>` : '';
            const songLine = escapeHtml(a.song || '—');
            const nameMuted = escapeHtml(a.name || '');
            const musicScore =
                a.matchScore != null && a.matchScore !== ''
                    ? `<p class="vibe-match-score">Match <strong>${escapeHtml(String(a.matchScore))}</strong>/10</p>`
                    : '';
            const slotScore = (s) =>
                s != null && s !== ''
                    ? `<p class="vibe-match-score vibe-match-score--small">${escapeHtml(String(s))}/10</p>`
                    : '';
            const srcTag = interactiveSourceLabelFromUrl(ix.url || '');
            const trailsHtml = trails.length
                ? trails
                      .map((t, i) => {
                          const u = urls[i] || `https://www.google.com/search?q=${encodeURIComponent(t)}`;
                          return `<li class="vibe-trail-item"><a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t)}</a></li>`;
                      })
                      .join('')
                : '';
            const trailsBlock =
                trails.length > 0
                    ? `<div class="vibe-search-trails-block">
                    <p class="vibe-search-trails-label">Search trails</p>
                    <ul class="vibe-search-trails-list">${trailsHtml}</ul>
                </div>`
                    : '';
            const exploreUrl = String(ph.exploreUrl || '').trim();
            const ixUrl = String(ix.url || '').trim();
            setVibeStage(`
                ${emo}
                <div class="vibe-results-stack">
                    <div class="vibe-rec-card vibe-rec-card--artist" data-card="artist">
                        <button type="button" class="vibe-favorite-btn" data-vibe-favorite="artist" title="Save to favorites"><i class="fa-regular fa-heart"></i></button>
                        <button type="button" class="vibe-reshuffle" data-reshuffle="artist" title="Reshuffle">🔀</button>
                        <div class="vibe-card-inner vibe-card-inner--artist" id="vibe-card-artist-inner">
                            <p class="vibe-card-kicker">Music</p>
                            <p class="vibe-artist-songline">${songLine}</p>
                            <p class="vibe-artist-nameline">${nameMuted}</p>
                            ${musicScore}
                            <p class="vibe-card-body vibe-card-body--friend">${escapeHtml(a.reason || '')}</p>
                            <div class="vibe-stream-links" role="group" aria-label="Listen">
                                <a class="secondary-btn vibe-stream-btn" href="${escapeHtml(a.songYoutubeUrl || '')}" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-youtube" aria-hidden="true"></i> YouTube search</a>
                                <a class="secondary-btn vibe-stream-btn" href="${escapeHtml(a.searchUrl || '')}" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-spotify" aria-hidden="true"></i> Spotify</a>
                                <a class="secondary-btn vibe-stream-btn" href="${escapeHtml(a.songSoundcloudUrl || '')}" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-soundcloud" aria-hidden="true"></i> SoundCloud</a>
                            </div>
                        </div>
                    </div>
                    <div class="vibe-rec-card vibe-rec-card--philosophy" data-card="philosophy">
                        <button type="button" class="vibe-favorite-btn" data-vibe-favorite="philosophy" title="Save to favorites"><i class="fa-regular fa-heart"></i></button>
                        <button type="button" class="vibe-reshuffle" data-reshuffle="philosophy" title="Reshuffle">🔀</button>
                        <div class="vibe-card-inner" id="vibe-card-philosophy-inner">
                            <p class="vibe-card-kicker">Design philosophy</p>
                            <p class="vibe-card-title vibe-philosophy-name">${escapeHtml(ph.name || '—')}</p>
                            <p class="vibe-philosophy-definition">${escapeHtml(ph.definition || '')}</p>
                            ${slotScore(ph.matchScore)}
                            <p class="vibe-card-body">${escapeHtml(ph.reason || '')}</p>
                            <button type="button" class="secondary-btn vibe-open-btn" data-vibe-link="philosophy">Explore</button>
                        </div>
                    </div>
                    <div class="vibe-rec-card vibe-rec-card--interactive" data-card="interactive">
                        <button type="button" class="vibe-favorite-btn" data-vibe-favorite="interactive" title="Save to favorites"><i class="fa-regular fa-heart"></i></button>
                        <button type="button" class="vibe-reshuffle" data-reshuffle="interactive" title="Reshuffle">🔀</button>
                        <div class="vibe-card-inner" id="vibe-card-interactive-inner">
                            <p class="vibe-card-kicker">Interactive <span class="vibe-type-tag">${escapeHtml(srcTag)}</span></p>
                            <p class="vibe-card-title">${escapeHtml([ix.siteName, ix.experienceName].filter(Boolean).join(' — ') || '—')}</p>
                            ${slotScore(ix.matchScore)}
                            <p class="vibe-card-body">${escapeHtml(ix.reason || '')}</p>
                            <p class="vibe-interactive-instruction">${escapeHtml(ix.instruction || '')}</p>
                            <button type="button" class="secondary-btn vibe-open-btn" data-vibe-link="interactive">Open it</button>
                        </div>
                    </div>
                </div>
                ${trailsBlock}
                <p class="vibe-error hidden" id="vibe-step2-err"></p>`);

            vibeStage.querySelector('[data-vibe-link="philosophy"]')?.addEventListener('click', () => {
                if (exploreUrl) window.open(exploreUrl, '_blank', 'noopener,noreferrer');
            });
            vibeStage.querySelector('[data-vibe-link="interactive"]')?.addEventListener('click', () => {
                if (ixUrl) window.open(ixUrl, '_blank', 'noopener,noreferrer');
            });

            vibeStage.querySelectorAll('[data-vibe-favorite]').forEach((btn) => {
                btn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const k = btn.getAttribute('data-vibe-favorite');
                    if (k === 'artist' || k === 'philosophy' || k === 'interactive') void saveFavoriteFromVibe(k);
                });
            });

            const vibeSlotKey = (k) => {
                if (k === 'artist') {
                    const ar = vibeState.rec?.artist;
                    return `${String(ar?.name || '')}|${String(ar?.song || '')}`;
                }
                if (k === 'philosophy') {
                    const x = vibeState.rec?.philosophy;
                    return String(x?.name || '').toLowerCase();
                }
                const x = vibeState.rec?.interactive;
                return String(x?.url || '');
            };

            vibeStage.querySelectorAll('.vibe-reshuffle').forEach((b) => {
                b.addEventListener('click', async () => {
                    const kind = b.getAttribute('data-reshuffle');
                    const card = b.closest('.vibe-rec-card');
                    const inner = card.querySelector('.vibe-card-inner');
                    const prevName = vibeSlotKey(kind);
                    inner.innerHTML = cardSpinner();
                    const errEl = document.getElementById('vibe-step2-err');
                    if (errEl) errEl.classList.add('hidden');
                    try {
                        await runVibeReshuffle(kind, prevName);
                        const nextName = vibeSlotKey(kind);
                        const hist =
                            kind === 'artist'
                                ? vibeState.historyArtist
                                : kind === 'philosophy'
                                  ? vibeState.historyPhilosophy
                                  : vibeState.historyInteractive;
                        if (hist.includes(nextName) || nextName === prevName) {
                            if (errEl) {
                                errEl.textContent = 'Got a duplicate suggestion — try reshuffle again.';
                                errEl.classList.remove('hidden');
                            }
                        } else {
                            if (kind === 'artist') vibeState.historyArtist.push(nextName);
                            else if (kind === 'philosophy') vibeState.historyPhilosophy.push(nextName);
                            else vibeState.historyInteractive.push(nextName);
                        }
                        renderResultsStep();
                    } catch (e) {
                        if (errEl) {
                            errEl.textContent = e.message || String(e);
                            errEl.classList.remove('hidden');
                        }
                        renderResultsStep();
                    }
                });
            });
        }

        function formatVibeLoadingCountdown(totalSeconds) {
            const m = Math.floor(totalSeconds / 60);
            const s = totalSeconds % 60;
            return `${m}:${String(s).padStart(2, '0')}`;
        }

        /** Maps remaining seconds (60→0) to green→red for slime strokes. */
        function slimeStrokeStyleFromSeconds(sec) {
            const t = Math.max(0, Math.min(1, sec / 60));
            const from = { r: 34, g: 197, b: 94 };
            const to = { r: 239, g: 68, b: 68 };
            const R = Math.round(to.r * (1 - t) + from.r * t);
            const Gch = Math.round(to.g * (1 - t) + from.g * t);
            const B = Math.round(to.b * (1 - t) + from.b * t);
            return {
                stroke: `rgb(${R},${Gch},${B})`,
                shadow: `rgba(${R},${Gch},${B},0.5)`
            };
        }

        /**
         * Slime doodle: delayed snake trail, color from loadingUi.secondsLeft (green→red).
         * After 0:00, loadingUi.flashBlank toggles to flash blank vs drawing until disposed.
         */
        function attachVibeLoadingSlimeDoodle(loadingUi) {
            const canvas = document.getElementById('vibe-loading-canvas');
            if (!canvas || !canvas.getContext) return () => {};
            const ctx = canvas.getContext('2d');
            const TRAIL_LAG_MS = 115;
            const MAX_POINTS_PER_STROKE = 600;
            let logicalW = 320;
            let logicalH = 132;
            const strokes = [];
            let drawing = false;
            let rafId = 0;
            let ro = null;

            function resize() {
                const wrap = canvas.closest('.vibe-loading-doodle-wrap');
                const r = wrap ? wrap.getBoundingClientRect() : canvas.getBoundingClientRect();
                logicalW = Math.max(200, Math.floor(r.width));
                logicalH = Math.max(160, Math.floor(r.height));
                const dpr = Math.min(window.devicePixelRatio || 1, 2);
                canvas.style.width = `${logicalW}px`;
                canvas.style.height = `${logicalH}px`;
                canvas.width = Math.floor(logicalW * dpr);
                canvas.height = Math.floor(logicalH * dpr);
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            }

            function clamp(p) {
                return {
                    x: Math.max(0, Math.min(logicalW, p.x)),
                    y: Math.max(0, Math.min(logicalH, p.y))
                };
            }

            function localPos(e) {
                const rect = canvas.getBoundingClientRect();
                const cx = e.clientX;
                const cy = e.clientY;
                return clamp({
                    x: cx - rect.left,
                    y: cy - rect.top
                });
            }

            function paint() {
                const now = performance.now();
                ctx.clearRect(0, 0, logicalW, logicalH);
                const sec = loadingUi && typeof loadingUi.secondsLeft === 'number' ? loadingUi.secondsLeft : 60;
                const flashBlank =
                    loadingUi && sec <= 0 && loadingUi.flashBlank === true;
                if (flashBlank) {
                    rafId = requestAnimationFrame(paint);
                    return;
                }
                const { stroke: strokeCol, shadow: shadowCol } = slimeStrokeStyleFromSeconds(sec);
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.strokeStyle = strokeCol;
                ctx.fillStyle = strokeCol;
                ctx.lineWidth = 3;
                ctx.shadowColor = shadowCol;
                ctx.shadowBlur = 6;

                for (const stroke of strokes) {
                    const delayed = stroke.filter((p) => p.t <= now - TRAIL_LAG_MS);
                    if (delayed.length >= 2) {
                        ctx.beginPath();
                        ctx.moveTo(delayed[0].x, delayed[0].y);
                        for (let i = 1; i < delayed.length; i++) {
                            ctx.lineTo(delayed[i].x, delayed[i].y);
                        }
                        ctx.stroke();
                    } else if (delayed.length === 1) {
                        ctx.beginPath();
                        ctx.arc(delayed[0].x, delayed[0].y, 2, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
                ctx.shadowBlur = 0;
                rafId = requestAnimationFrame(paint);
            }

            function addPoint(e) {
                if (!drawing || strokes.length === 0) return;
                const p = localPos(e);
                const cur = strokes[strokes.length - 1];
                cur.push({ x: p.x, y: p.y, t: performance.now() });
                if (cur.length > MAX_POINTS_PER_STROKE) cur.splice(0, cur.length - MAX_POINTS_PER_STROKE);
            }

            function onDown(e) {
                if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                drawing = true;
                strokes.push([]);
                addPoint(e);
                try {
                    canvas.setPointerCapture(e.pointerId);
                } catch (_) {
                    /* ignore */
                }
            }

            function onMove(e) {
                if (!drawing) return;
                e.preventDefault();
                addPoint(e);
            }

            function onUp(e) {
                if (!drawing) return;
                drawing = false;
                try {
                    canvas.releasePointerCapture(e.pointerId);
                } catch (_) {
                    /* ignore */
                }
            }

            const listenerOpts = { passive: false };

            resize();
            requestAnimationFrame(() => {
                resize();
                requestAnimationFrame(() => resize());
            });
            rafId = requestAnimationFrame(paint);
            window.addEventListener('resize', resize);
            if (typeof ResizeObserver !== 'undefined') {
                ro = new ResizeObserver(() => resize());
                const wrap = canvas.closest('.vibe-loading-doodle-wrap');
                if (wrap) ro.observe(wrap);
            }

            canvas.addEventListener('pointerdown', onDown, listenerOpts);
            canvas.addEventListener('pointermove', onMove, listenerOpts);
            canvas.addEventListener('pointerup', onUp);
            canvas.addEventListener('pointercancel', onUp);
            canvas.addEventListener('lostpointercapture', onUp);

            return () => {
                cancelAnimationFrame(rafId);
                window.removeEventListener('resize', resize);
                if (ro) ro.disconnect();
                if (loadingUi && loadingUi.flashIntervalId) {
                    clearInterval(loadingUi.flashIntervalId);
                    loadingUi.flashIntervalId = null;
                }
                canvas.removeEventListener('pointerdown', onDown, listenerOpts);
                canvas.removeEventListener('pointermove', onMove, listenerOpts);
                canvas.removeEventListener('pointerup', onUp);
                canvas.removeEventListener('pointercancel', onUp);
                canvas.removeEventListener('lostpointercapture', onUp);
            };
        }

        async function startFindMyVibe(frameEl) {
            const ta = frameEl.querySelector('.journal-entry-textarea');
            const entry = (ta && ta.value.trim()) || '';
            if (!entry) {
                alert('Write something in your journal first.');
                return;
            }
            if (!auth.currentUser) {
                console.warn('slimemytaste: not signed in — run still works; sign in to sync to Firestore.');
            }
            vibeState.frame = frameEl;
            vibeState.entry = entry.slice(0, 500);
            vibeState.selected = [];
            vibeState.rec = null;
            vibeState.historyArtist = [];
            vibeState.historyPhilosophy = [];
            vibeState.historyInteractive = [];
            openVibePanel();
            const slimeServersMsg =
                'SlimeServers are still connecting... wait 1 more second for me 5';
            let secondsLeft = 60;
            const loadingUi = {
                secondsLeft: 60,
                flashBlank: false,
                flashIntervalId: null,
                flashStarted: false
            };
            setVibeStage(`<div class="vibe-loading" id="vibe-loading-root">
                <p class="vibe-loading-summon-hint">click and drag on this canvas to summon that slime</p>
                <div class="vibe-loading-head">
                    <i class="fa-solid fa-spinner fa-spin vibe-loading-spinner" aria-hidden="true"></i>
                    <p class="vibe-loading-countdown" id="vibe-countdown-display">${formatVibeLoadingCountdown(secondsLeft)}</p>
                </div>
                <p class="vibe-loading-status" id="vibe-loading-status" aria-live="polite"></p>
                <div class="vibe-loading-doodle-wrap">
                    <canvas class="vibe-loading-canvas" id="vibe-loading-canvas" role="img" aria-label="Slime drawing canvas"></canvas>
                </div>
            </div>`);
            const disposeLoadingDoodle = attachVibeLoadingSlimeDoodle(loadingUi);
            let countdownIntervalId = null;
            const tick = () => {
                const cd = document.getElementById('vibe-countdown-display');
                const st = document.getElementById('vibe-loading-status');
                if (!cd) return;
                secondsLeft -= 1;
                loadingUi.secondsLeft = Math.max(0, secondsLeft);
                if (secondsLeft > 0) {
                    cd.textContent = formatVibeLoadingCountdown(secondsLeft);
                    if (st) st.textContent = '';
                } else {
                    cd.textContent = '0:00';
                    if (st) st.textContent = slimeServersMsg;
                    if (!loadingUi.flashStarted) {
                        loadingUi.flashStarted = true;
                        loadingUi.flashBlank = false;
                        loadingUi.flashIntervalId = setInterval(() => {
                            loadingUi.flashBlank = !loadingUi.flashBlank;
                        }, 480);
                    }
                }
            };
            countdownIntervalId = setInterval(tick, 1000);
            try {
                const full = await runVibeJournalToRecommendations(vibeState.entry);
                vibeState.primaryEmotion = full.primaryEmotion || '';
                vibeState.rec = {
                    artist: full.artist,
                    philosophy: full.philosophy,
                    interactive: full.interactive,
                    searchTrails: full.searchTrails,
                    searchUrls: full.searchUrls
                };
                vibeState.historyArtist = [
                    `${String(vibeState.rec?.artist?.name || '')}|${String(vibeState.rec?.artist?.song || '')}`
                ];
                vibeState.historyPhilosophy = [String(vibeState.rec?.philosophy?.name || '').toLowerCase()];
                vibeState.historyInteractive = [String(vibeState.rec?.interactive?.url || '')];
                renderResultsStep();
            } catch (e) {
                setVibeStage(
                    `<div class="vibe-error-panel"><p>${escapeHtml(e.message || String(e))}</p><button type="button" class="primary-btn" id="vibe-retry">Try again</button></div>`
                );
                document.getElementById('vibe-retry').addEventListener('click', () => startFindMyVibe(frameEl));
            } finally {
                if (countdownIntervalId) clearInterval(countdownIntervalId);
                if (typeof disposeLoadingDoodle === 'function') disposeLoadingDoodle();
            }
        }

        function ensureJournalUiOnFrame(frameEl) {
            if (!frameEl || !frameEl.classList.contains('motif-frame')) return;
            const body = frameEl.querySelector('.frame-body');
            if (!body || body.querySelector('.find-vibe-btn')) return;
            const taOld = body.querySelector('.journal-entry-textarea');
            const prev = taOld ? taOld.value : '';
            body.classList.add('journal-frame-body');
            body.innerHTML = `
                <textarea class="journal-entry-textarea" maxlength="500" rows="6" placeholder="What's on your mind?"></textarea>
                <div class="journal-toolbar">
                    <span class="journal-char-count">0 / 500</span>
                    <button type="button" class="primary-btn find-vibe-btn">you need to see ts</button>
                </div>`;
            const ta = body.querySelector('.journal-entry-textarea');
            if (ta && prev) ta.value = prev.slice(0, 500);
        }

        function bindJournalFrame(frameEl) {
            ensureJournalUiOnFrame(frameEl);
            const ta = frameEl.querySelector('.journal-entry-textarea');
            const cnt = frameEl.querySelector('.journal-char-count');
            if (!ta || !cnt) return;
            if (ta.dataset.journalInputBound === '1') return;
            const syncCount = () => {
                const n = ta.value.length;
                cnt.textContent = n + ' / 500';
                if (n > 500) ta.value = ta.value.slice(0, 500);
            };
            ta.addEventListener('input', () => {
                syncCount();
                scheduleCloudSave();
            });
            syncCount();
            ta.dataset.journalInputBound = '1';
        }

        /** Delegation: survives ensureJournalUiOnFrame() replacing the button DOM (WeakSet skip left stale handlers). */
        boardContainer.addEventListener(
            'click',
            (e) => {
                const btn = e.target.closest('.find-vibe-btn');
                if (!btn || !canvas.contains(btn)) return;
                const frameEl = btn.closest('.motif-frame');
                if (!frameEl) return;
                e.preventDefault();
                e.stopPropagation();
                void startFindMyVibe(frameEl);
            },
            true
        );

        function wireAllJournalFrames() {
            canvas.querySelectorAll('.motif-frame').forEach(bindJournalFrame);
        }

        let currentTool = 'select';
        let scale = 1;
        let panX = window.innerWidth / 2;
        let panY = window.innerHeight / 2;

        function updateCanvasTransform() {
            canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
        }
        updateCanvasTransform();

        const toolBtns = document.querySelectorAll('.tool-btn');
        toolBtns.forEach((btn) => {
            btn.addEventListener('click', () => {
                toolBtns.forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                currentTool = btn.dataset.tool;
                if (currentTool === 'journal') boardContainer.style.cursor = 'crosshair';
                else if (currentTool === 'pan') boardContainer.style.cursor = 'grab';
                else boardContainer.style.cursor = 'default';
            });
        });

        function setTool(toolName) {
            toolBtns.forEach((btn) => {
                if (btn.dataset.tool === toolName) btn.click();
            });
        }

        boardContainer.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey || e.deltaY % 1 !== 0) {
                const zoomSensitivity = 0.005;
                const delta = -e.deltaY * zoomSensitivity;
                const newScale = Math.min(Math.max(0.1, scale + delta), 5);
                const mouseX = e.clientX;
                const mouseY = e.clientY;
                panX = mouseX - (mouseX - panX) * (newScale / scale);
                panY = mouseY - (mouseY - panY) * (newScale / scale);
                scale = newScale;
            } else {
                panX -= e.deltaX;
                panY -= e.deltaY;
            }
            updateCanvasTransform();
        }, { passive: false });

        const historyStack = [];
        const getGhostFrame = () => document.getElementById('ghost-frame');

        function saveStateSafe() {
            stashJournalSnapshotsBeforeHistory();
            const ghost = getGhostFrame();
            document.querySelectorAll('#canvas input').forEach((inp) => inp.setAttribute('value', inp.value));
            if (ghost && ghost.parentNode === canvas) canvas.removeChild(ghost);
            historyStack.push(canvas.innerHTML);
            if (historyStack.length > 30) historyStack.shift();
            if (ghost) canvas.prepend(ghost);
            restoreJournalSnapshotsAfterInnerHtml();
            scheduleCloudSave();
        }

        function undoSafe() {
            const ghost = getGhostFrame();
            if (historyStack.length > 0) {
                if (ghost && ghost.parentNode === canvas) canvas.removeChild(ghost);
                canvas.innerHTML = historyStack.pop();
                if (ghost) canvas.prepend(ghost);
                deselectAll();
                restoreJournalSnapshotsAfterInnerHtml();
                wireAllJournalFrames();
            }
            scheduleCloudSave();
        }

        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
                e.preventDefault();
                undoSafe();
                return;
            }
            if (document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
                if (e.key.toLowerCase() === 'v') setTool('select');
                if (e.key.toLowerCase() === 'j') setTool('journal');
            }
            if (e.key === 'Backspace' || e.key === 'Delete') {
                if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
                const selectedElements = document.querySelectorAll('.selected');
                if (selectedElements.length > 0) {
                    saveStateSafe();
                    selectedElements.forEach((el) => el.remove());
                }
            }
        });

        boardContainer.addEventListener('input', (e) => {
            if (e.target.tagName === 'INPUT') e.target.setAttribute('value', e.target.value);
            if (e.target.classList.contains('journal-entry-textarea')) {
                const fr = e.target.closest('.motif-frame');
                if (fr) fr.setAttribute('data-journal-snapshot', encodeURIComponent(e.target.value));
            }
        });

        let isPanning = false;
        let isDrawing = false;
        let dragType = null;
        let draggingElement = null;
        let dragStartX, dragStartY;
        let initialLeft, initialTop, initialWidth, initialHeight;
        let stateSavedForDrag = false;
        let containedElementsToMove = [];
        let lastMousedownTime = 0;

        boardContainer.addEventListener('mousedown', (e) => {
            const rawT = e.target;
            const targetEl = rawT instanceof Element ? rawT : rawT && rawT.parentElement;
            if (!(targetEl instanceof Element)) return;
            if (targetEl.closest('.top-toolbar')) return;
            if (targetEl.closest('#vibe-panel-overlay') || targetEl.closest('#favorites-panel-overlay')) return;

            const rect = canvas.getBoundingClientRect();
            const pointerX = (e.clientX - rect.left) / scale;
            const pointerY = (e.clientY - rect.top) / scale;
            const now = Date.now();
            const isDoubleClick = now - lastMousedownTime < 300;
            lastMousedownTime = now;
            const individualDragHandle = targetEl.closest('.individual-drag-handle');
            let executeIndividualMove = (currentTool === 'pan' && isDoubleClick) || !!individualDragHandle;

            if ((currentTool === 'pan' && !isDoubleClick) || e.button === 1 || e.code === 'Space') {
                isPanning = true;
                dragStartX = e.clientX - panX;
                dragStartY = e.clientY - panY;
                boardContainer.style.cursor = 'grabbing';
                return;
            }

            const deleteBtnEarly = targetEl.closest('.delete-btn');
            if (deleteBtnEarly) {
                const parentEl = deleteBtnEarly.closest('.motif-frame');
                if (parentEl) {
                    saveStateSafe();
                    parentEl.remove();
                }
                return;
            }

            if (
                targetEl.closest('.find-vibe-btn') ||
                targetEl.closest('.journal-entry-textarea') ||
                targetEl.closest('.journal-toolbar') ||
                targetEl.closest('.frame-header input')
            ) {
                return;
            }

            if (currentTool === 'journal') {
                isDrawing = true;
                dragStartX = pointerX;
                dragStartY = pointerY;
                const ghost = getGhostFrame();
                ghost.style.display = 'block';
                ghost.style.left = dragStartX + 'px';
                ghost.style.top = dragStartY + 'px';
                ghost.style.width = '0px';
                ghost.style.height = '0px';
                ghost.style.borderStyle = 'solid';
                ghost.style.background = 'rgba(107, 92, 231, 0.1)';
                deselectAll();
                return;
            }

            const frameResizeHandle = targetEl.closest('.frame-resize-handle');
            const frameHeader = targetEl.closest('.frame-header');
            const frameBody = targetEl.closest('.frame-body');
            const frame = targetEl.closest('.motif-frame');

            if (targetEl.tagName === 'INPUT' || targetEl.tagName === 'TEXTAREA' || targetEl.closest('.journal-entry-textarea')) {
                if (frame) selectElement(frame, 'frame');
                return;
            }

            if (individualDragHandle) {
                const parentElement = individualDragHandle.closest('.motif-frame');
                if (parentElement) {
                    startDrag(e, parentElement, 'move', pointerX, pointerY, true);
                    selectElement(parentElement, 'frame');
                }
            } else if (frameResizeHandle) {
                startDrag(e, frame, 'resize', pointerX, pointerY, executeIndividualMove);
            } else if (frameHeader) {
                startDrag(e, frame, 'move', pointerX, pointerY, executeIndividualMove);
                selectElement(frame, 'frame');
            } else if (frameBody && frame) {
                selectElement(frame, 'frame');
            } else if (frame) {
                selectElement(frame, 'frame');
            } else deselectAll();
        });

        function startDrag(e, element, type, px, py, isDoubleClickDrag = false) {
            draggingElement = element;
            dragType = type;
            dragStartX = px;
            dragStartY = py;
            stateSavedForDrag = false;
            initialLeft = parseFloat(element.style.left) || 0;
            initialTop = parseFloat(element.style.top) || 0;
            initialWidth = parseFloat(element.style.width) || element.offsetWidth;
            initialHeight = parseFloat(element.style.height) || element.offsetHeight;
            containedElementsToMove = [];
            e.stopPropagation();
        }

        window.addEventListener('mousemove', (e) => {
            if (isPanning) {
                panX = e.clientX - dragStartX;
                panY = e.clientY - dragStartY;
                updateCanvasTransform();
                return;
            }
            const rect = canvas.getBoundingClientRect();
            const pointerX = (e.clientX - rect.left) / scale;
            const pointerY = (e.clientY - rect.top) / scale;
            if (isDrawing) {
                const ghost = getGhostFrame();
                const width = Math.abs(pointerX - dragStartX);
                const height = Math.abs(pointerY - dragStartY);
                const left = Math.min(pointerX, dragStartX);
                const top = Math.min(pointerY, dragStartY);
                ghost.style.left = left + 'px';
                ghost.style.top = top + 'px';
                ghost.style.width = width + 'px';
                ghost.style.height = height + 'px';
                return;
            }
            if (draggingElement && dragType) {
                const dx = pointerX - dragStartX;
                const dy = pointerY - dragStartY;
                if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
                    if (!stateSavedForDrag) {
                        saveStateSafe();
                        stateSavedForDrag = true;
                    }
                }
                if (dragType === 'move') {
                    draggingElement.style.left = initialLeft + dx + 'px';
                    draggingElement.style.top = initialTop + dy + 'px';
                    containedElementsToMove.forEach((item) => {
                        item.el.style.left = item.left + dx + 'px';
                        item.el.style.top = item.top + dy + 'px';
                    });
                } else if (dragType === 'resize') {
                    draggingElement.style.width = Math.max(50, initialWidth + dx) + 'px';
                    draggingElement.style.height = Math.max(50, initialHeight + dy) + 'px';
                }
            }
        });

        window.addEventListener('mouseup', () => {
            if (isPanning) {
                isPanning = false;
                boardContainer.style.cursor = currentTool === 'pan' ? 'grab' : 'default';
            }
            if (isDrawing) {
                isDrawing = false;
                const ghost = getGhostFrame();
                ghost.style.display = 'none';
                const width = parseFloat(ghost.style.width);
                const height = parseFloat(ghost.style.height);
                const left = parseFloat(ghost.style.left);
                const top = parseFloat(ghost.style.top);
                if (width > 50 && height > 50) {
                    saveStateSafe();
                    if (currentTool === 'journal') createFrameAt(left, top, width, height);
                }
                setTool('select');
            }
            draggingElement = null;
            dragType = null;
            containedElementsToMove = [];
        });

        function createFrameAt(x, y, w, h) {
            const frameId = 'frame-' + Date.now();
            const frame = document.createElement('div');
            frame.className = 'motif-frame';
            frame.id = frameId;
            frame.style.left = x + 'px';
            frame.style.top = y + 'px';
            frame.style.width = w + 'px';
            frame.style.height = h + 'px';
            frame.style.zIndex = '1';
            frame.innerHTML = `
            <div class="frame-header">
                <input type="text" class="frame-title" placeholder="Frame" value="New journal">
                <button type="button" class="delete-btn" title="Delete frame"><i class="fa-solid fa-trash"></i></button>
            </div>
            <div class="frame-body journal-frame-body">
                <textarea class="journal-entry-textarea" maxlength="500" rows="6" placeholder="What's on your mind?"></textarea>
                <div class="journal-toolbar">
                    <span class="journal-char-count">0 / 500</span>
                    <button type="button" class="primary-btn find-vibe-btn">you need to see ts</button>
                </div>
            </div>
            <div class="frame-resize-handle"></div>
            <div class="individual-drag-handle" title="Move Individually"></div>`;
            canvas.appendChild(frame);
            bindJournalFrame(frame);
            selectElement(frame, 'frame');
            scheduleCloudSave();
        }

        function selectElement(el, type) {
            deselectAll();
            el.classList.add('selected');
            if (type === 'frame') el.style.zIndex = '10';
        }

        function deselectAll() {
            document.querySelectorAll('.motif-frame').forEach((f) => {
                f.classList.remove('selected');
                f.style.zIndex = '1';
            });
        }

        if (saveCloudBtn) {
            saveCloudBtn.addEventListener('click', async () => {
                if (!auth.currentUser) return;
                saveCloudBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                try {
                    await persistBoardToCloud({ silent: false });
                    saveCloudBtn.innerHTML = '<i class="fa-solid fa-check" style="color: #10B981;"></i>';
                    setTimeout(() => {
                        saveCloudBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i>';
                    }, 2000);
                } catch (error) {
                    console.error('Save error:', error);
                    saveCloudBtn.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="color: #EF4444;"></i>';
                    setTimeout(() => {
                        saveCloudBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i>';
                    }, 2000);
                    const code = error && error.code ? error.code : '';
                    const msg = error && error.message ? error.message : String(error);
                    alert(
                        `Save failed${code ? ` (${code})` : ''}: ${msg}\n\nIf you see permission-denied, deploy the rules in this repo:\nfirebase deploy --only firestore:rules`
                    );
                }
            });
        }

        wireAllJournalFrames();

        console.log('slimemytaste: journal app ready.');
    } catch (e) {
        alert('Fatal error during app boot: ' + (e.message || String(e)));
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void initApp());
} else {
    void initApp();
}
