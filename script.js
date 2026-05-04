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
import { buildCuratorSystemPrompt, buildVibeGroqOutputContract } from './curator-prompt.js';

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

/** Unique id per vibe run so Groq treats each journal click as a fresh curation. */
function vibeSessionStamp() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function isLikelyYoutubeVideoId(v) {
    if (!v || typeof v !== 'string') return false;
    return /^[\w-]{11}$/.test(v.trim());
}

function urlPassesArtFindPolicy(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const u = new URL(url);
        const h = u.hostname.replace(/^www\./, '');
        if (youtubeHost(h)) {
            if (u.pathname.startsWith('/results')) return true;
            if (u.searchParams.has('search_query')) return true;
            if (u.pathname === '/watch' && isLikelyYoutubeVideoId(u.searchParams.get('v') || '')) return true;
            if (u.pathname.startsWith('/shorts/')) {
                const id = u.pathname.replace(/^\/shorts\//, '').split('/')[0];
                return isLikelyYoutubeVideoId(id);
            }
        }
        if (u.hostname === 'youtu.be') {
            const id = u.pathname.replace(/^\//, '').split('/')[0];
            return isLikelyYoutubeVideoId(id);
        }
        if (h === 'vimeo.com') {
            if (u.pathname.startsWith('/search')) return true;
            if (/^\/\d+(?:\/|$)/.test(u.pathname)) return true;
        }
        if (h === 'artsandculture.google.com') return true;
        if (h === 'archive.org') return true;
        if (h === 'google.com' && (u.searchParams.get('tbm') === 'isch' || u.pathname.startsWith('/search')))
            return true;
        const museums = ['moma.org', 'metmuseum.org', 'tate.org.uk'];
        if (museums.some((m) => h === m || h.endsWith('.' + m))) return true;
        const knownLive = ['patatap.com', 'radio.garden', 'windows93.net', 'thequietplace.xyz', 'neal.fun'];
        if (knownLive.includes(h)) return true;
        if (h === 'instagram.com' && /^\/(p|reel|tv)\/[\w-]+/.test(u.pathname)) return true;
        return false;
    } catch {
        return false;
    }
}

function coerceArtFindUrl(art) {
    if (!art || typeof art !== 'object') return;
    const q = `${art.name || ''} ${art.type || ''}`.trim() || art.name || 'art';
    const url = String(art.findUrl || '').trim();
    if (url && urlPassesArtFindPolicy(url)) return;
    art.findUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
}

function normalizeRecommendationUrls(rec) {
    if (!rec || typeof rec !== 'object') return rec;
    const song = rec.artist?.song || '';
    const name = rec.artist?.name || '';
    const spotifyQ = [song, name].filter(Boolean).join(' ').trim() || name || 'music';
    if (rec.artist && typeof rec.artist === 'object') {
        rec.artist.searchUrl = `https://open.spotify.com/search/${encodeURIComponent(spotifyQ)}`;
        const ytCandidate =
            rec.artist.songYoutubeUrl ||
            (/youtube\.com\/watch|youtu\.be\//i.test(String(rec.artist.albumCover || ''))
                ? rec.artist.albumCover
                : null);
        rec.artist.songYoutubeUrl = resolveYoutubeSongUrl(ytCandidate, spotifyQ);
        rec.artist.songSoundcloudUrl = `https://soundcloud.com/search/sounds?q=${encodeURIComponent(spotifyQ)}`;
    }
    coerceArtFindUrl(rec.art1);
    coerceArtFindUrl(rec.art2);
    let trails = Array.isArray(rec.searchTrails) ? rec.searchTrails.map((t) => String(t || '').trim()).filter(Boolean) : [];
    while (trails.length < 3) trails.push('underground rap emotional texture scene');
    trails = trails.slice(0, 3);
    rec.searchTrails = trails;
    rec.searchUrls = trails.map((t) => `https://www.google.com/search?q=${encodeURIComponent(t)}`);
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
            console.log('MyMotif: auth persistence →', name);
            return;
        } catch (e) {
            console.warn('MyMotif: persistence failed (' + name + '):', e && (e.code || e.message));
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
        console.log('My Motif: Starting journal build…');
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
                console.warn('[MyMotif] getRedirectResult:', c, err.message || err);
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
            groqKeySettingsBtn.style.display = auth.currentUser && getGroqApiKey() ? 'flex' : 'none';
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
                console.warn('MyMotif: could not load frame entries:', e && (e.code || e.message));
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
                                messages: [{ role: 'user', content: fullPromptText }],
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
            <aside class="vibe-panel-drawer" role="dialog" aria-modal="true" aria-label="Vibe finder">
                <div class="vibe-panel-header">
                    <h2 class="vibe-panel-title">Find your vibe</h2>
                    <button type="button" class="vibe-panel-close icon-btn" title="Close" data-vibe-close="1"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="vibe-panel-body" id="vibe-panel-stage"></div>
                <p class="vibe-panel-footer-note">Art lives everywhere. These are starting points.</p>
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
                        '<p class="favorites-empty">No favorites yet. Run &ldquo;Find your vibe&rdquo; and tap the heart on a suggestion.</p>';
                    return;
                }
                let html =
                    '<p class="favorites-doc-intro">Saved by <strong>mood</strong> — each card shows what you wrote that session and what you saved (music with streaming links, or art as a title link).</p><div class="favorites-doc">';
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
            historyArt1: [],
            historyArt2: []
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
            else if (kind === 'art1') snapshot = r.art1 ? JSON.parse(JSON.stringify(r.art1)) : null;
            else if (kind === 'art2') snapshot = r.art2 ? JSON.parse(JSON.stringify(r.art2)) : null;
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

        /** Curator + task + Groq output contract (link rules, close reading, schema hints). */
        function buildVibeFullPrompt(userTaskText) {
            return `${buildCuratorSystemPrompt()}\n\n=== USER TASK ===\n\n${userTaskText}\n\n${buildVibeGroqOutputContract()}`;
        }

        /** Truncate long reasons in reshuffle payload to save input tokens. */
        function compactVibeRecForPrompt(rec, maxReasonChars = 200) {
            if (!rec || typeof rec !== 'object') return '{}';
            const cut = (s) => {
                const t = String(s ?? '');
                return t.length <= maxReasonChars ? t : `${t.slice(0, maxReasonChars)}…`;
            };
            const pack = (art) =>
                art && typeof art === 'object'
                    ? {
                          name: art.name,
                          type: art.type,
                          reason: cut(art.reason),
                          findUrl: art.findUrl
                      }
                    : art;
            const a = rec.artist;
            return JSON.stringify({
                artist: a
                    ? {
                          name: a.name,
                          song: a.song,
                          albumCover: a.albumCover,
                          songYoutubeUrl: a.songYoutubeUrl,
                          songSoundcloudUrl: a.songSoundcloudUrl,
                          reason: cut(a.reason),
                          searchUrl: a.searchUrl
                      }
                    : undefined,
                art1: pack(rec.art1),
                art2: pack(rec.art2),
                searchTrails: rec.searchTrails,
                searchUrls: rec.searchUrls
            });
        }

        async function runVibeJournalToRecommendations(entryText) {
            const session = vibeSessionStamp();
            const userPrompt = `CURATION SESSION: ${session} — This is a new run (new journal or new click). Do not repeat boilerplate picks from prior turns; surface fresh music + art. Lean niche / weird / underground visual culture per system prompt.

Close-read the journal: quote their phrases in reasons; reasons = journal-only (no song name/lyrics/"this track"). You MUST output artist.song as a real released track (exact title) that exists on streaming for that artist — never invent titles. art2 type ≠ art1.

JSON shape:
{"primaryEmotion":"","artist":{"name":"","song":"","albumCover":null,"songYoutubeUrl":null,"songSoundcloudUrl":null,"reason":"","searchUrl":"spotify"},"art1":{"name":"","type":"","reason":"","findUrl":""},"art2":{"name":"","type":"","reason":"","findUrl":""},"searchTrails":["","",""],"searchUrls":["","",""]}

Journal:
---
${entryText}
---`;

            const fullPrompt = buildVibeFullPrompt(userPrompt);
            const data = await groqChatCompletion(fullPrompt, {
                temperature: 0.93,
                max_tokens: 4096
            });
            const parsed = normalizeRecommendationUrls(parseVibeJsonFromResponse(data));
            if (!parsed || typeof parsed !== 'object') throw new Error('Invalid model response.');
            if (!parsed.artist?.name || !parsed.art1?.name || !parsed.art2?.name) {
                throw new Error('Model response missing artist, art1, or art2. Try again.');
            }
            const songTitle = String(parsed.artist?.song || '').trim();
            if (!songTitle) {
                throw new Error('Model returned no specific song title. Try again.');
            }
            return parsed;
        }

        async function runVibeReshuffle(kind, avoidName) {
            const entryText = vibeState.entry;
            const emotion = vibeState.primaryEmotion;
            const vibeAnswersText =
                vibeState.selected && vibeState.selected.filter(Boolean).length
                    ? JSON.stringify(vibeState.selected)
                    : '(Infer from journal and emotion only.)';
            const slotLabel =
                kind === 'artist'
                    ? 'artist (name, song, albumCover, songYoutubeUrl, songSoundcloudUrl, reason, searchUrl)'
                    : kind === 'art1'
                      ? 'art1 (must stay a different category than art2 after replacement)'
                      : 'art2 (must stay a different category than art1 after replacement)';
            const currentJson = compactVibeRecForPrompt(vibeState.rec);
            const session = vibeSessionStamp();
            const userPrompt = `RESHUFFLE SESSION: ${session} — Fresh alternative required (not a repeat of common defaults).

Different ${slotLabel}; do not repeat "${avoidName}". Artist swap = another **real** released song (exact title on streaming); reasons journal-only.

Journal: ${entryText}
Emotion: ${emotion}
Vibe: ${vibeAnswersText}

CURRENT (replace only "${kind}"; echo rest unchanged):
${currentJson}

Return full JSON: primaryEmotion, artist, art1, art2, searchTrails, searchUrls.`;

            const fullPrompt = buildVibeFullPrompt(userPrompt);
            const data = await groqChatCompletion(fullPrompt, {
                temperature: 0.95,
                max_tokens: 4096
            });
            const parsed = normalizeRecommendationUrls(parseVibeJsonFromResponse(data));
            if (parsed && typeof parsed === 'object') {
                if (parsed.primaryEmotion) vibeState.primaryEmotion = parsed.primaryEmotion;
                vibeState.rec = {
                    artist: parsed.artist || vibeState.rec.artist,
                    art1: parsed.art1 || vibeState.rec.art1,
                    art2: parsed.art2 || vibeState.rec.art2,
                    searchTrails: parsed.searchTrails || vibeState.rec.searchTrails,
                    searchUrls: parsed.searchUrls || vibeState.rec.searchUrls
                };
                normalizeRecommendationUrls(vibeState.rec);
            }
        }

        function cardSpinner() {
            return '<div class="vibe-card-spinner"><i class="fa-solid fa-spinner fa-spin"></i></div>';
        }

        function renderResultsStep() {
            const r = vibeState.rec || {};
            const a = r.artist || {};
            const art1 = r.art1 || {};
            const art2 = r.art2 || {};
            const trails = Array.isArray(r.searchTrails) ? r.searchTrails : [];
            const urls = Array.isArray(r.searchUrls) ? r.searchUrls : [];
            const emo = vibeState.primaryEmotion ? `<p class="vibe-emotion-label"><em>${escapeHtml(vibeState.primaryEmotion)}</em></p>` : '';
            const songLine = escapeHtml(a.song || '—');
            const nameMuted = escapeHtml(a.name || '');
            const trailsHtml = [0, 1, 2]
                .map((i) => {
                    const t = trails[i] || '—';
                    const u = urls[i] || `https://www.google.com/search?q=${encodeURIComponent(t)}`;
                    return `<li class="vibe-trail-item"><a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t)}</a></li>`;
                })
                .join('');
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
                            <p class="vibe-card-body vibe-card-body--friend">${escapeHtml(a.reason || '')}</p>
                            <div class="vibe-stream-links" role="group" aria-label="Listen">
                                <a class="secondary-btn vibe-stream-btn" href="${escapeHtml(a.songYoutubeUrl || '')}" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-youtube" aria-hidden="true"></i> YouTube</a>
                                <a class="secondary-btn vibe-stream-btn" href="${escapeHtml(a.searchUrl || '')}" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-spotify" aria-hidden="true"></i> Spotify</a>
                                <a class="secondary-btn vibe-stream-btn" href="${escapeHtml(a.songSoundcloudUrl || '')}" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-soundcloud" aria-hidden="true"></i> SoundCloud</a>
                            </div>
                        </div>
                    </div>
                    <div class="vibe-rec-card" data-card="art1">
                        <button type="button" class="vibe-favorite-btn" data-vibe-favorite="art1" title="Save to favorites"><i class="fa-regular fa-heart"></i></button>
                        <button type="button" class="vibe-reshuffle" data-reshuffle="art1" title="Reshuffle">🔀</button>
                        <div class="vibe-card-inner" id="vibe-card-art1-inner">
                            <p class="vibe-card-kicker">Art <span class="vibe-type-tag">${escapeHtml(art1.type || '')}</span></p>
                            <p class="vibe-card-title">${escapeHtml(art1.name || '—')}</p>
                            <p class="vibe-card-body">${escapeHtml(art1.reason || '')}</p>
                            <button type="button" class="secondary-btn vibe-open-btn" data-vibe-link="art1">Find it</button>
                        </div>
                    </div>
                    <div class="vibe-rec-card" data-card="art2">
                        <button type="button" class="vibe-favorite-btn" data-vibe-favorite="art2" title="Save to favorites"><i class="fa-regular fa-heart"></i></button>
                        <button type="button" class="vibe-reshuffle" data-reshuffle="art2" title="Reshuffle">🔀</button>
                        <div class="vibe-card-inner" id="vibe-card-art2-inner">
                            <p class="vibe-card-kicker">More art <span class="vibe-type-tag">${escapeHtml(art2.type || '')}</span></p>
                            <p class="vibe-card-title">${escapeHtml(art2.name || '—')}</p>
                            <p class="vibe-card-body">${escapeHtml(art2.reason || '')}</p>
                            <button type="button" class="secondary-btn vibe-open-btn" data-vibe-link="art2">Find it</button>
                        </div>
                    </div>
                </div>
                <div class="vibe-search-trails-block">
                    <p class="vibe-search-trails-label">Search trails</p>
                    <ul class="vibe-search-trails-list">${trailsHtml}</ul>
                </div>
                <p class="vibe-error hidden" id="vibe-step2-err"></p>`);

            const art1Url = art1.findUrl || '';
            const art2Url = art2.findUrl || '';

            vibeStage.querySelector('[data-vibe-link="art1"]')?.addEventListener('click', () => {
                if (art1Url) window.open(art1Url, '_blank', 'noopener,noreferrer');
            });
            vibeStage.querySelector('[data-vibe-link="art2"]')?.addEventListener('click', () => {
                if (art2Url) window.open(art2Url, '_blank', 'noopener,noreferrer');
            });

            vibeStage.querySelectorAll('[data-vibe-favorite]').forEach((btn) => {
                btn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const k = btn.getAttribute('data-vibe-favorite');
                    if (k === 'artist' || k === 'art1' || k === 'art2') void saveFavoriteFromVibe(k);
                });
            });

            vibeStage.querySelectorAll('.vibe-reshuffle').forEach((b) => {
                b.addEventListener('click', async () => {
                    const kind = b.getAttribute('data-reshuffle');
                    const card = b.closest('.vibe-rec-card');
                    const inner = card.querySelector('.vibe-card-inner');
                    const prevName =
                        kind === 'artist'
                            ? String(vibeState.rec?.artist?.name || '')
                            : kind === 'art1'
                              ? String(vibeState.rec?.art1?.name || '')
                              : String(vibeState.rec?.art2?.name || '');
                    inner.innerHTML = cardSpinner();
                    const errEl = document.getElementById('vibe-step2-err');
                    if (errEl) errEl.classList.add('hidden');
                    try {
                        await runVibeReshuffle(kind, prevName);
                        const nextName =
                            kind === 'artist'
                                ? String(vibeState.rec?.artist?.name || '')
                                : kind === 'art1'
                                  ? String(vibeState.rec?.art1?.name || '')
                                  : String(vibeState.rec?.art2?.name || '');
                        const hist =
                            kind === 'artist'
                                ? vibeState.historyArtist
                                : kind === 'art1'
                                  ? vibeState.historyArt1
                                  : vibeState.historyArt2;
                        if (hist.includes(nextName) || nextName === prevName) {
                            if (errEl) {
                                errEl.textContent = 'Got a duplicate suggestion — try reshuffle again.';
                                errEl.classList.remove('hidden');
                            }
                        } else {
                            if (kind === 'artist') vibeState.historyArtist.push(nextName);
                            else if (kind === 'art1') vibeState.historyArt1.push(nextName);
                            else vibeState.historyArt2.push(nextName);
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

        async function startFindMyVibe(frameEl) {
            const ta = frameEl.querySelector('.journal-entry-textarea');
            const entry = (ta && ta.value.trim()) || '';
            if (!entry) {
                alert('Write something in your journal first.');
                return;
            }
            if (!auth.currentUser) {
                console.warn('MyMotif: not signed in — vibe still runs; sign in to sync to Firestore.');
            }
            vibeState.frame = frameEl;
            vibeState.entry = entry.slice(0, 500);
            vibeState.selected = [];
            vibeState.rec = null;
            vibeState.historyArtist = [];
            vibeState.historyArt1 = [];
            vibeState.historyArt2 = [];
            openVibePanel();
            setVibeStage(
                '<div class="vibe-loading"><i class="fa-solid fa-spinner fa-spin"></i><p>Matching your vibe to music & art…</p></div>'
            );
            try {
                const full = await runVibeJournalToRecommendations(vibeState.entry);
                vibeState.primaryEmotion = full.primaryEmotion || '';
                vibeState.rec = {
                    artist: full.artist,
                    art1: full.art1,
                    art2: full.art2,
                    searchTrails: full.searchTrails,
                    searchUrls: full.searchUrls
                };
                vibeState.historyArtist = [String(vibeState.rec?.artist?.name || '')];
                vibeState.historyArt1 = [String(vibeState.rec?.art1?.name || '')];
                vibeState.historyArt2 = [String(vibeState.rec?.art2?.name || '')];
                renderResultsStep();
            } catch (e) {
                setVibeStage(
                    `<div class="vibe-error-panel"><p>${escapeHtml(e.message || String(e))}</p><button type="button" class="primary-btn" id="vibe-retry">Try again</button></div>`
                );
                document.getElementById('vibe-retry').addEventListener('click', () => startFindMyVibe(frameEl));
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

        console.log('My Motif: journal app ready.');
    } catch (e) {
        alert('Fatal error during app boot: ' + (e.message || String(e)));
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void initApp());
} else {
    void initApp();
}
