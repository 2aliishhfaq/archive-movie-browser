import React, { useEffect, useMemo, useState } from 'react';

const imageFallback = 'https://placehold.co/480x720/171717/f5f5f5?text=No+Poster';
const INSTALL_CHECK_INTERVAL = 24 * 60 * 60 * 1000;

function getDownloadUrl(source, movieTitle, directArchive = false) {
  try {
    const url = new URL(source);
    const host = url.hostname.toLowerCase();
    if (host === 'archive.org' || host.endsWith('.archive.org')) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'download' && parts[1]) {
        if (directArchive) {
          url.searchParams.set('download', '1');
          return url.toString();
        }
        const proxy = new URL('https://archive-movie-proxy.2aliishhfaq.workers.dev/');
        proxy.searchParams.set('url', url.toString());
        proxy.searchParams.set('download', '1');
        proxy.searchParams.set('filename', movieTitle || 'Reelbox Movie');
        return proxy.toString();
      }
      if (parts[0] === 'details' && parts[1]) return url.toString();
    }
    return url.toString();
  } catch { return source; }
}

function getArchiveEmbedUrl(source) {
  try {
    const url = new URL(source);
    const host = url.hostname.toLowerCase();
    if (host !== 'archive.org' && !host.endsWith('.archive.org')) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const route = parts[0];
    if (!['download', 'details', 'embed'].includes(route) || !parts[1]) return null;
    const identifier = decodeURIComponent(parts[1]);
    const embed = new URL('https://archive.org/embed/' + encodeURIComponent(identifier));
    if (route === 'download' && parts.length > 2) {
      const filename = decodeURIComponent(parts.slice(2).join('/'));
      embed.searchParams.set('file', filename);
    }
    embed.searchParams.set('autoplay', '1');
    return embed.toString();
  } catch { return null; }
}

const CATALOG_EDGE_URL = 'https://archive-movie-proxy.2aliishhfaq.workers.dev';

function makeArchiveDownloadUrl(identifier, filename) {
  return 'https://archive.org/download/' + encodeURIComponent(identifier) + '/' +
    filename.split('/').map(encodeURIComponent).join('/');
}

function pickArchiveVideoFile(files = []) {
  const priority = { mp4: 100, m4v: 95, webm: 90, ogv: 70, ogg: 65 };
  return files
    .filter(file => file && typeof file.name === 'string' && file.name.length < 500)
    .map(file => {
      const extension = file.name.split('.').pop().toLowerCase();
      return { file, score: priority[extension] || 0 };
    })
    .filter(item => item.score > 0 && (!item.file.source || item.file.source === 'original'))
    .sort((left, right) => right.score - left.score || Number(right.file.size || 0) - Number(left.file.size || 0))[0]?.file || null;
}

async function fetchArchiveCatalog(searchParams) {
  if (searchParams.get('categories') === '1') {
    return { data: { categories: ['Archive.org'] }, cache: 'ARCHIVE-FALLBACK' };
  }

  const limit = Math.min(24, Math.max(1, Number.parseInt(searchParams.get('limit') || '24', 10) || 24));
  const offset = Math.max(0, Number.parseInt(searchParams.get('offset') || '0', 10) || 0);
  const query = String(searchParams.get('q') || '').trim().slice(0, 100)
    .replace(/["\\[\\]{}:*]/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();

  const searchUrl = new URL('https://archive.org/advancedsearch.php');
  searchUrl.searchParams.set('q', query ? 'mediatype:movies AND (' + query + ')' : 'mediatype:movies');
  searchUrl.searchParams.append('fl[]', 'identifier');
  searchUrl.searchParams.append('fl[]', 'title');
  searchUrl.searchParams.set('rows', String(limit));
  searchUrl.searchParams.set('page', String(Math.floor(offset / limit) + 1));
  searchUrl.searchParams.set('output', 'json');
  searchUrl.searchParams.append('sort[]', 'downloads desc');

  const searchResponse = await fetch(searchUrl.toString(), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
  if (!searchResponse.ok) throw new Error('Archive.org search unavailable');
  const searchData = await searchResponse.json();
  const docs = searchData?.response?.docs || [];
  const movies = [];

  // Resolve exact playback files for only the first four results. Remaining cards use
  // Archive.org's own details player, limiting metadata calls during provider outages.
  for (let index = 0; index < docs.length; index += 4) {
    const batch = await Promise.all(docs.slice(index, index + 4).map(async (doc, batchIndex) => {
      const identifier = String(doc.identifier || '').trim();
      if (!/^[a-zA-Z0-9._-]{1,200}$/.test(identifier)) return null;
      let movieLink = 'https://archive.org/details/' + encodeURIComponent(identifier);
      if (index + batchIndex < 4) {
        try {
          const metadataResponse = await fetch('https://archive.org/metadata/' + encodeURIComponent(identifier), {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(6000),
          });
          if (metadataResponse.ok) {
            const metadataData = await metadataResponse.json();
            const file = pickArchiveVideoFile(metadataData.files);
            if (file) movieLink = makeArchiveDownloadUrl(identifier, file.name);
          }
        } catch { /* Details embed remains playable if file metadata is unavailable. */ }
      }
      return {
        id: 'archive-' + identifier,
        movie_name: String(doc.title || identifier).trim().slice(0, 240),
        category: 'Archive.org',
        poster: 'https://archive.org/services/img/' + encodeURIComponent(identifier),
        movie_link: movieLink,
        direct_archive: movieLink.includes('/details/'),
      };
    }));
    movies.push(...batch.filter(Boolean));
  }

  return {
    data: { movies, total: Number(searchData?.response?.numFound || movies.length), limit, offset },
    cache: 'ARCHIVE-FALLBACK',
  };
}

async function fetchCatalogData(searchParams) {
  const query = searchParams.toString();
  try {
    const response = await fetch(CATALOG_EDGE_URL + '/catalog' + (query ? '?' + query : ''), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(7000),
    });
    if (response.ok) {
      return {
        data: await response.json(),
        cache: response.headers.get('X-Cache') || response.headers.get('X-Edge-Cache') || 'EDGE',
      };
    }
  } catch { /* Cloudflare quota/network failures fall through to Vercel, then Archive.org. */ }

  try {
    const response = await fetch('/api/movies' + (query ? '?' + query : ''), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(7000),
    });
    if (response.ok) {
      const data = await response.json();
      return {
        data: data.movies ? { ...data, movies: data.movies.map(movie => ({ ...movie, direct_archive: true })) } : data,
        cache: 'VERCEL-DIRECT',
      };
    }
  } catch { /* Vercel Hobby limits/outages fall through to Archive.org. */ }

  return fetchArchiveCatalog(searchParams);
}

function MovieBrowser() {
  const [movies, setMovies] = useState([]);
  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cache, setCache] = useState('');
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showInstallNotice, setShowInstallNotice] = useState(false);
  const [installHelp, setInstallHelp] = useState(false);

  const pageSize = 24;
  const params = useMemo(() => {
    const p = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
    if (query.trim()) p.set('q', query.trim());
    if (category) p.set('category', category);
    return p.toString();
  }, [query, category, page]);

  useEffect(() => {
    fetchCatalogData(new URLSearchParams({ categories: '1' }))
      .then(({ data }) => setCategories(data.categories || ['Archive.org']))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    fetchCatalogData(new URLSearchParams(params))
      .then(({ data, cache }) => ({ data, cache }))
      .then(({ data, cache: cacheStatus }) => {
        if (!active) return;
        setMovies(data.movies || []);
        setTotal(data.total || 0);
        setCache(cacheStatus);
      })
      .catch(e => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [params]);

  useEffect(() => { setPage(0); }, [query, category]);

  useEffect(() => {
    let deferred = null;
    let active = true;
    const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const checkInstallState = async (forcePrompt = false) => {
      if (!active || isStandalone()) { setShowInstallNotice(false); return; }
      const canCheckInstalled = typeof navigator.getInstalledRelatedApps === 'function';
      const wasInstalled = localStorage.getItem('reelbox-pwa-installed') === '1';
      if (!canCheckInstalled && wasInstalled) { setShowInstallNotice(false); return; }
      let installed = false;
      if (canCheckInstalled) {
        try { installed = (await navigator.getInstalledRelatedApps()).some(app => app.platform === 'webapp'); }
        catch { /* Browser does not expose install-state checks. */ }
      }
      if (!active) return;
      if (installed) {
        localStorage.setItem('reelbox-pwa-installed', '1');
        localStorage.setItem('reelbox-install-last-check', String(Date.now()));
        setShowInstallNotice(false);
        return;
      }
      const lastCheck = Number(localStorage.getItem('reelbox-install-last-check') || 0);
      const dismissedUntil = Number(localStorage.getItem('reelbox-install-dismissed-until') || 0);
      if (forcePrompt || !lastCheck || Date.now() - lastCheck >= INSTALL_CHECK_INTERVAL) {
        localStorage.setItem('reelbox-install-last-check', String(Date.now()));
        localStorage.removeItem('reelbox-pwa-installed');
        if (Date.now() >= dismissedUntil && (deferred || wasInstalled)) setShowInstallNotice(true);
      }
    };
    const onBeforeInstall = event => {
      event.preventDefault();
      deferred = event;
      setInstallPrompt(event);
      checkInstallState(true);
    };
    const onInstalled = () => {
      deferred = null;
      setInstallPrompt(null);
      setShowInstallNotice(false);
      setInstallHelp(false);
      localStorage.setItem('reelbox-pwa-installed', '1');
      localStorage.setItem('reelbox-install-last-check', String(Date.now()));
      localStorage.removeItem('reelbox-install-dismissed-until');
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    checkInstallState();
    const intervalId = window.setInterval(checkInstallState, INSTALL_CHECK_INTERVAL);
    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  async function installReelbox() {
    if (!installPrompt) { setInstallHelp(true); return; }
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice?.outcome === 'accepted') { setShowInstallNotice(false); setInstallPrompt(null); }
  }

  function dismissInstallNotice() {
    setShowInstallNotice(false);
    localStorage.setItem('reelbox-install-dismissed-until', String(Date.now() + INSTALL_CHECK_INTERVAL));
  }

  const archivePlayerUrl = selected ? getArchiveEmbedUrl(selected.movie_link) : null;

  useEffect(() => {
    if (!selected) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [selected]);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return <main className="shell">
    <header className="topbar">
      <a className="brand" href="/" aria-label="Archive Movie Browser home"><span className="brand-mark">A</span><span>ARCHIVE<span className="brand-light"> / MOVIES</span></span></a>
      <nav className="top-nav"><span className="top-note">INDEPENDENT FILM ARCHIVE</span><a className="admin-tab" href="/admin">ADMIN</a></nav>
    </header>
    <section className="browse-tools" aria-label="Find movies">
      <label className="search-box"><span aria-hidden="true">⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search movies..." aria-label="Search movies"/></label>
      <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Filter by category"><option value="">All categories</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select>
    </section>
    <section className="catalog">
      <div className="section-heading"><div><p className="eyebrow">THE COLLECTION</p><h2>{category || 'Browse films'}</h2></div><span className="count">{total.toLocaleString()} FILMS {cache ? '· CACHE ' + cache : ''}</span></div>
      {error && <div className="notice error">{error}. Please try again shortly.</div>}
      {loading ? <div className="grid">{Array.from({length:12},(_,i)=><div className="skeleton-card" key={i}/>)}</div>
      : movies.length ? <div className="grid">{movies.map(movie=><button className="movie-card" key={movie.id} onClick={()=>setSelected(movie)}>
        <span className="poster-wrap"><img src={movie.poster || imageFallback} alt="" loading="lazy" onError={e=>{e.currentTarget.src=imageFallback}}/><span className="play-badge">▶</span></span>
        <span className="movie-meta"><strong>{movie.movie_name}</strong><small>{movie.category || 'UNCATEGORIZED'}</small></span>
      </button>)}</div>
      : !error && <div className="empty"><span>✳</span><h3>No films found</h3><p>Try another title or category.</p></div>}
      <div className="pagination"><button disabled={page===0 || loading} onClick={()=>setPage(p=>Math.max(0,p-1))}>← Previous</button><span>PAGE {page+1} OF {Math.max(1,Math.ceil(total/pageSize))}</span><button disabled={loading || (page+1)*pageSize>=total} onClick={()=>setPage(p=>p+1)}>Next →</button></div>
    </section>
    <footer><span>ARCHIVE / MOVIES</span><div className="footer-links"><a href="https://archive.org" target="_blank" rel="noreferrer">PRESERVED BY THE INTERNET ARCHIVE ↗</a></div></footer>
    {showInstallNotice && <aside className="install-prompt" role="dialog" aria-label="Install Reelbox">
      <button className="install-dismiss" type="button" onClick={dismissInstallNotice} aria-label="Dismiss install prompt">×</button>
      <span className="install-mark">R</span>
      <div className="install-copy"><strong>Install Reelbox</strong><span>Add Reelbox to your desktop or home screen for one-tap access.</span></div>
      <button className="install-action" type="button" onClick={installReelbox}>INSTALL APP</button>
    </aside>}
    {installHelp && <div className="install-help-backdrop" role="presentation" onClick={() => setInstallHelp(false)}>
      <section className="install-help" role="dialog" aria-modal="true" aria-label="Install Reelbox instructions" onClick={e => e.stopPropagation()}>
        <button className="install-dismiss" type="button" onClick={() => setInstallHelp(false)} aria-label="Close">×</button>
        <p className="eyebrow">REELBOX APP</p><h2>Add Reelbox to your device</h2>
        <p>Open your browser menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>. Your browser will create the Reelbox shortcut.</p>
        <button className="install-action" type="button" onClick={() => setInstallHelp(false)}>GOT IT</button>
      </section>
    </div>}
    {selected && <div className="modal-backdrop" role="presentation" onClick={()=>setSelected(null)}><section className="player-modal" role="dialog" aria-modal="true" aria-label={selected.movie_name} onClick={e=>e.stopPropagation()}>
      <div className="player-modal-top">
        <span>NOW PLAYING · ARCHIVE.ORG</span>
        <button className="close" onClick={()=>setSelected(null)} aria-label="Close player">×</button>
      </div>
      <div className="video-frame">{archivePlayerUrl
        ? <iframe key={archivePlayerUrl} title={selected.movie_name + ' — Internet Archive player'} src={archivePlayerUrl} width="640" height="480" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowFullScreen loading="eager" referrerPolicy="strict-origin-when-cross-origin" />
        : <video key={selected.movie_link} controls playsInline preload="metadata" poster={selected.poster || undefined} src={selected.movie_link}><a href={selected.movie_link}>Open video source</a></video>}</div>
      <div className="player-info"><div><p className="eyebrow">{selected.category || 'ARCHIVE FILM'}</p><h2>{selected.movie_name}</h2></div><a className="download-button" href={getDownloadUrl(selected.movie_link, selected.movie_name, selected.direct_archive)} aria-label={'Download ' + selected.movie_name} download>DOWNLOAD NOW ↓</a></div>
    </section></div>}
  </main>;
}


function AdminPanel() {
  const [token, setToken] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Feature Films');
  const [limit, setLimit] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [manualMovie, setManualMovie] = useState({ movie_name: '', category: '', poster: '', movie_link: '' });
  const [manualBusy, setManualBusy] = useState(false);
  const [manualMessage, setManualMessage] = useState('');
  const [adminMovies, setAdminMovies] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [adminLoading, setAdminLoading] = useState(false);

  async function loadAdminMovies(authToken = token) {
    if (!authToken.trim()) return;
    setAdminLoading(true);
    try {
      const response = await fetch('/api/movies?admin=1&limit=500&offset=0', { headers: { Authorization: 'Bearer ' + authToken.trim() } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load movie library.');
      setAdminMovies(data.movies || []);
    } catch (err) { setError(err.message || 'Could not load movie library.'); }
    finally { setAdminLoading(false); }
  }

  useEffect(() => {
    const saved = window.sessionStorage.getItem('archive-admin-token');
    if (!saved) return;
    fetch('/api/movies?admin=1&limit=1', { headers: { Authorization: 'Bearer ' + saved } })
      .then(response => {
        if (!response.ok) throw new Error('Admin session expired.');
        setToken(saved);
        setAuthorized(true);
        loadAdminMovies(saved);
      })
      .catch(() => window.sessionStorage.removeItem('archive-admin-token'));
  }, []);

  async function unlockDashboard(event) {
    event.preventDefault();
    setError('');
    setAuthBusy(true);
    try {
      const authToken = token.trim();
      const response = await fetch('/api/movies?admin=1&limit=1', { headers: { Authorization: 'Bearer ' + authToken } });
      if (!response.ok) throw new Error('Incorrect password. Access denied.');
      window.sessionStorage.setItem('archive-admin-token', authToken);
      setAuthorized(true);
      await loadAdminMovies(authToken);
    } catch (err) { setError(err.message || 'Could not verify password.'); }
    finally { setAuthBusy(false); }
  }

  async function deleteMovie(id) {
    if (!window.confirm('Delete this movie from the public catalogue?')) return;
    try {
      const response = await fetch('/api/movies', { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token.trim() }, body: JSON.stringify({ id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Delete failed.');
      setAdminMovies(rows => rows.filter(movie => String(movie.id) !== String(id)));
      setManualMessage('Movie deleted from the catalogue.');
    } catch (err) { setError(err.message || 'Delete failed.'); }
  }

  function editMovie(movie) {
    setEditingId(movie.id);
    setManualMovie({ movie_name: movie.movie_name || '', category: movie.category || '', poster: movie.poster || '', movie_link: movie.movie_link || '' });
    document.getElementById('movie-editor')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function publishMovie(event) {
    event.preventDefault();
    setManualMessage('');
    setManualBusy(true);
    try {
      const response = await fetch('/api/movies', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token.trim() },
        body: JSON.stringify(editingId ? { ...manualMovie, id: editingId } : manualMovie),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save movie.');
      setManualMessage(editingId ? 'Movie updated successfully.' : 'Movie published to the public catalogue.');
      setManualMovie({ movie_name: '', category: '', poster: '', movie_link: '' });
      setEditingId(null);
      await loadAdminMovies();
    } catch (err) { setManualMessage(err.message || 'Save failed.'); }
    finally { setManualBusy(false); }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setResult(null);
    setBusy(true);
    try {
      const response = await fetch('/api/movies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token.trim() },
        body: JSON.stringify({ action: 'import', query, category, limit }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Import request failed.');
      setResult(data);
      await loadAdminMovies();
    } catch (err) { setError(err.message || 'Import failed. Please try again.'); }
    finally { setBusy(false); }
  }

  function clearToken() {
    window.sessionStorage.removeItem('archive-admin-token');
    setToken('');
    setAuthorized(false);
    setAdminMovies([]);
    setResult(null);
    setError('');
    setManualMessage('');
  }

  return <main className="admin-shell">
    <header className="topbar">
      <a className="brand" href="/" aria-label="Back to Archive Movies"><span className="brand-mark">A</span><span>ARCHIVE<span className="brand-light"> / ADMIN</span></span></a>
      <a className="admin-back" href="/">← BACK TO CATALOG</a>
    </header>
    {!authorized ? <section className="admin-content admin-login-only">
      <p className="eyebrow">RESTRICTED AREA</p>
      <h1>Admin<br/><em>access only.</em></h1>
      <p className="admin-copy">Enter the administrator password to unlock the movie management dashboard.</p>
      <section className="dashboard-section admin-access">
        <form className="admin-form" onSubmit={unlockDashboard}>
          <label>ADMIN PASSWORD
            <input type="password" autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} placeholder="Enter dashboard password" required />
          </label>
          <button className="admin-submit" type="submit" disabled={authBusy}>{authBusy ? 'VERIFYING…' : 'UNLOCK DASHBOARD'}</button>
        </form>
        {error && <div className="admin-message admin-error" role="alert">{error}</div>}
      </section>
    </section> : <>
      <section className="admin-content">
        <p className="eyebrow">COLLECTION MANAGEMENT</p>
        <h1>Bring films<br/><em>into the archive.</em></h1>
        <p className="admin-copy">Search Internet Archive movie records and import playable files into your Neon catalog. Duplicate links and items without supported video files are skipped.</p>
        <section className="dashboard-section" id="movie-editor">
          <div className="dashboard-section-heading"><p className="eyebrow">YOUR MOVIE LIBRARY</p><h2>{editingId ? 'Edit movie' : 'Add your own movie'}</h2><p>Paste an Internet Archive video URL. Published movies appear in the public catalog.</p></div>
          <form className="admin-form" onSubmit={publishMovie}>
            <label>MOVIE TITLE<input value={manualMovie.movie_name} onChange={e => setManualMovie({...manualMovie, movie_name:e.target.value})} placeholder="Movie title" maxLength={240} required /></label>
            <div className="admin-fields">
              <label>CATEGORY<input value={manualMovie.category} onChange={e => setManualMovie({...manualMovie, category:e.target.value})} placeholder="e.g. Action, Drama" maxLength={100} /></label>
              <label>POSTER IMAGE URL<input value={manualMovie.poster} onChange={e => setManualMovie({...manualMovie, poster:e.target.value})} placeholder="https://..." type="url" /></label>
            </div>
            <label>INTERNET ARCHIVE VIDEO URL<input value={manualMovie.movie_link} onChange={e => setManualMovie({...manualMovie, movie_link:e.target.value})} placeholder="https://archive.org/download/..." type="url" required /></label>
            <button className="admin-submit" type="submit" disabled={manualBusy}>{manualBusy ? 'SAVING…' : editingId ? 'SAVE MOVIE CHANGES ↗' : 'PUBLISH TO USER CATALOG ↗'}</button>
            {editingId && <button className="admin-clear" type="button" onClick={() => { setEditingId(null); setManualMovie({ movie_name: '', category: '', poster: '', movie_link: '' }); }}>CANCEL EDIT</button>}
          </form>
          {manualMessage && <div className="admin-message" role="status">{manualMessage}</div>}
        </section>
        <section className="dashboard-section">
          <div className="dashboard-section-heading"><p className="eyebrow">MANAGE PUBLISHED MOVIES</p><h2>Movie library</h2><p>Edit or remove movies already visible to visitors.</p></div>
          <button className="admin-submit" type="button" onClick={() => loadAdminMovies()} disabled={adminLoading}>{adminLoading ? 'LOADING…' : 'REFRESH MOVIE LIBRARY'}</button>
          <div className="admin-imported">{adminMovies.map(movie => <div key={movie.id}><strong>{movie.movie_name}</strong><span>{movie.category || 'Uncategorized'} · <button type="button" className="admin-inline" onClick={() => editMovie(movie)}>EDIT</button> · <button type="button" className="admin-inline danger" onClick={() => deleteMovie(movie.id)}>DELETE</button></span></div>)}</div>
          <p className="admin-security">{adminMovies.length} movie records loaded.</p>
        </section>
        <section className="dashboard-section">
          <div className="dashboard-section-heading"><p className="eyebrow">INTERNET ARCHIVE</p><h2>Import public archive films</h2><p>Search Internet Archive and add playable films to the same catalog.</p></div>
          <form className="admin-form" onSubmit={handleSubmit}>
            <label>SEARCH INTERNET ARCHIVE<input value={query} onChange={e => setQuery(e.target.value)} placeholder="Leave blank to browse Feature Films" maxLength={120} /></label>
            <div className="admin-fields">
              <label>CATALOG CATEGORY<input value={category} onChange={e => setCategory(e.target.value)} placeholder="Feature Films" maxLength={100} /></label>
              <label>IMPORT LIMIT<select value={limit} onChange={e => setLimit(Number(e.target.value))}><option value={3}>3 films</option><option value={5}>5 films</option></select></label>
            </div>
            <button className="admin-submit" type="submit" disabled={busy}>{busy ? 'IMPORTING FILMS…' : 'SEARCH & IMPORT FILMS ↗'}</button>
          </form>
          {error && <div className="admin-message admin-error" role="alert">{error}</div>}
          {result && <section className="admin-result" aria-live="polite"><div className="admin-stats"><div><strong>{result.importedCount}</strong><span>IMPORTED</span></div><div><strong>{result.skippedCount}</strong><span>SKIPPED</span></div><div><strong>{result.totalFound}</strong><span>FOUND</span></div></div><p>{result.message}</p>{result.imported?.length > 0 && <div className="admin-imported">{result.imported.map(movie => <div key={movie.id}><strong>{movie.movie_name}</strong><span>{movie.category}</span></div>)}</div>}<a className="admin-view" href="/">VIEW PUBLIC CATALOG ↗</a></section>}
        </section>
        <p className="admin-security">Dashboard access is verified by the server. This session is stored only in the current browser tab.</p>
        <button className="admin-clear" type="button" onClick={clearToken}>LOCK ADMIN DASHBOARD</button>
      </section>
    </>}
    <footer><span>ARCHIVE / MOVIES</span><a href="/">RETURN TO CATALOG ↗</a></footer>
  </main>;
}

export default function App() {
  return window.location.pathname === '/admin' ? <AdminPanel /> : <MovieBrowser />;
}
