import React, { useEffect, useMemo, useState } from 'react';

const imageFallback = 'https://placehold.co/480x720/171717/f5f5f5?text=No+Poster';

function archiveEmbedUrl(source) {
  try {
    const url = new URL(source);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'download' || parts.length < 3) return source;
    const identifier = parts[1];
    const filename = decodeURIComponent(parts.slice(2).join('/'));
    return 'https://archive.org/embed/' + encodeURIComponent(identifier) +
      '?autoplay=1&file=' + encodeURIComponent(filename);
  } catch { return source; }
}

function browserPlayable(source) {
  try {
    const pathname = new URL(source).pathname.toLowerCase();
    return /\.(mp4|m4v|webm|ogv|ogg)$/.test(pathname);
  } catch { return false; }
}

function MovieBrowser() {
  const [movies, setMovies] = useState([]);
  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState(null);
  const [useArchivePlayer, setUseArchivePlayer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cache, setCache] = useState('');

  const pageSize = 24;
  const params = useMemo(() => {
    const p = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
    if (query.trim()) p.set('q', query.trim());
    if (category) p.set('category', category);
    return p.toString();
  }, [query, category, page]);

  useEffect(() => {
    fetch('/api/movies?categories=1')
      .then(r => r.ok ? r.json() : Promise.reject(new Error('Could not load categories')))
      .then(data => setCategories(data.categories || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    fetch('/api/movies?' + params)
      .then(async r => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Movie service is unavailable');
        return { data, cache: r.headers.get('X-Cache') || '' };
      })
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
    let archiveSource = false;
    try {
      const host = new URL(selected?.movie_link || '').hostname.toLowerCase();
      archiveSource = host === 'archive.org' || host.endsWith('.archive.org');
    } catch { /* Invalid URLs stay in the standard player's error state. */ }
    setUseArchivePlayer(Boolean(selected && archiveSource && !browserPlayable(selected.movie_link)));
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
    {selected && <div className="modal-backdrop" role="presentation" onClick={()=>setSelected(null)}><section className="player-modal" role="dialog" aria-modal="true" aria-label={selected.movie_name} onClick={e=>e.stopPropagation()}>
      <button className="close" onClick={()=>setSelected(null)} aria-label="Close player">×</button>
      <div className="video-frame">{useArchivePlayer
        ? <iframe title={selected.movie_name + ' — Internet Archive player'} src={archiveEmbedUrl(selected.movie_link)} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen loading="eager" />
        : <video controls autoPlay playsInline preload="metadata" poster={selected.poster || undefined} src={selected.movie_link} onError={() => {
          try {
            const host = new URL(selected.movie_link).hostname.toLowerCase();
            if (host === 'archive.org' || host.endsWith('.archive.org')) setUseArchivePlayer(true);
          } catch { /* Keep the source link available if a host rejects playback. */ }
        }}><a href={selected.movie_link}>Open video source</a></video>}</div>
      <div className="player-info"><div><p className="eyebrow">{selected.category || 'ARCHIVE FILM'}</p><h2>{selected.movie_name}</h2></div><a className="download-button" href={selected.movie_link} target="_blank" rel="noopener noreferrer" aria-label={'Download ' + selected.movie_name}>DOWNLOAD NOW ↓</a></div>
    </section></div>}
  </main>;
}


function AdminPanel() {
  const [token, setToken] = useState('');
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
  const [authorized, setAuthorized] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);

  useEffect(() => {
    const saved = window.sessionStorage.getItem('archive-admin-token');
    if (!saved) return;
    fetch('/api/movies?admin=1&limit=1', { headers: { Authorization: 'Bearer ' + saved } })
      .then(response => { if (response.ok) { setToken(saved); setAuthorized(true); } else window.sessionStorage.removeItem('archive-admin-token'); })
      .catch(() => window.sessionStorage.removeItem('archive-admin-token'));
  }, []);

  async function unlockDashboard(event) {
    event.preventDefault();
    setError('');
    setAuthBusy(true);
    try {
      const response = await fetch('/api/movies?admin=1&limit=1', { headers: { Authorization: 'Bearer ' + token.trim() } });
      if (!response.ok) throw new Error('Incorrect password. Access denied.');
      window.sessionStorage.setItem('archive-admin-token', token.trim());
      setAuthorized(true);
      await loadAdminMovies();
    } catch (err) { setError(err.message || 'Could not verify password.'); }
    finally { setAuthBusy(false); }
  }

  if (!authorized) return <main className="admin-shell">
    <header className="topbar">
      <a className="brand" href="/" aria-label="Back to Archive Movies"><span className="brand-mark">A</span><span>ARCHIVE<span className="brand-light"> / ADMIN</span></span></a>
      <a className="admin-back" href="/">← BACK TO CATALOG</a>
    </header>
    <section className="admin-content admin-login-only">
      <p className="eyebrow">RESTRICTED AREA</p>
      <h1>Admin<br/><em>access only.</em></h1>
      <p className="admin-copy">Enter the administrator password to unlock the movie management dashboard.</p>
      <section className="dashboard-section" id="movie-editor">
        <div className="dashboard-section-heading">
          <p className="eyebrow">YOUR MOVIE LIBRARY</p>
          <h2>{editingId ? 'Edit movie' : 'Add your own movie'}</h2>
          <p>Enter a public HTTPS video URL. When you publish, the movie appears in the user catalog.</p>
        </div>
        <form className="admin-form" onSubmit={publishMovie}>
          <label>MOVIE TITLE
            <input value={manualMovie.movie_name} onChange={e => setManualMovie({...manualMovie, movie_name:e.target.value})} placeholder="Movie title" maxLength={240} required />
          </label>
          <div className="admin-fields">
            <label>CATEGORY
              <input value={manualMovie.category} onChange={e => setManualMovie({...manualMovie, category:e.target.value})} placeholder="e.g. Action, Drama" maxLength={100} />
            </label>
            <label>POSTER IMAGE URL
              <input value={manualMovie.poster} onChange={e => setManualMovie({...manualMovie, poster:e.target.value})} placeholder="https://..." type="url" />
            </label>
          </div>
          <label>VIDEO URL (PUBLIC HTTPS MP4 / WEBM)
            <input value={manualMovie.movie_link} onChange={e => setManualMovie({...manualMovie, movie_link:e.target.value})} placeholder="https://your-host.com/movie.mp4" type="url" required />
          </label>
          <button className="admin-submit" type="submit" disabled={manualBusy}>{manualBusy ? 'SAVING…' : editingId ? 'SAVE MOVIE CHANGES ↗' : 'PUBLISH TO USER CATALOG ↗'}</button>
          {editingId && <button className="admin-clear" type="button" onClick={() => { setEditingId(null); setManualMovie({ movie_name: '', category: '', poster: '', movie_link: '' }); }}>CANCEL EDIT</button>}
        </form>
        {manualMessage && <div className="admin-message" role="status">{manualMessage}</div>}
        <p className="admin-security">The video must already be hosted at a public HTTPS address. A file on your PC cannot stream until it is uploaded to a video host or storage such as Cloudflare R2.</p>
      </section>
      <section className="dashboard-section">
        <div className="dashboard-section-heading">
          <p className="eyebrow">MANAGE PUBLISHED MOVIES</p>
          <h2>Movie library</h2>
          <p>Edit or remove movies already visible to visitors.</p>
        </div>
        <button className="admin-submit" type="button" onClick={loadAdminMovies} disabled={adminLoading}>{adminLoading ? 'LOADING…' : 'REFRESH MOVIE LIBRARY'}</button>
        <div className="admin-imported">{adminMovies.map(movie => <div key={movie.id}><strong>{movie.movie_name}</strong><span>{movie.category || 'Uncategorized'} · <button type="button" className="admin-inline" onClick={() => editMovie(movie)}>EDIT</button> · <button type="button" className="admin-inline danger" onClick={() => deleteMovie(movie.id)}>DELETE</button></span></div>)}</div>
        <p className="admin-security">{adminMovies.length} movie records loaded.</p>
      </section>
      <section className="dashboard-section">
        <div className="dashboard-section-heading">
          <p className="eyebrow">INTERNET ARCHIVE</p>
          <h2>Import public archive films</h2>
          <p>Search the Internet Archive and add playable films to the same catalog.</p>
        </div>
        <form className="admin-form" onSubmit={handleSubmit}>
        <label>SEARCH INTERNET ARCHIVE
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Leave blank to browse the Feature Films collection" maxLength={120} />
        </label>
        <div className="admin-fields">
          <label>CATALOG CATEGORY
            <input value={category} onChange={e => setCategory(e.target.value)} placeholder="Feature Films" maxLength={100} />
          </label>
          <label>IMPORT LIMIT
            <select value={limit} onChange={e => setLimit(Number(e.target.value))}>
              <option value={3}>3 films</option><option value={5}>5 films</option>
            </select>
          </label>
        </div>
        <button className="admin-submit" type="submit" disabled={busy}>{busy ? 'IMPORTING FILMS…' : 'SEARCH & IMPORT FILMS ↗'}</button>
      </form>
      {error && <div className="admin-message admin-error" role="alert">{error}</div>}
      {result && <section className="admin-result" aria-live="polite">
        <div className="admin-stats"><div><strong>{result.importedCount}</strong><span>IMPORTED</span></div><div><strong>{result.skippedCount}</strong><span>SKIPPED</span></div><div><strong>{result.totalFound}</strong><span>FOUND</span></div></div>
        <p>{result.message}</p>
        {result.imported?.length > 0 && <div className="admin-imported">{result.imported.map(movie => <div key={movie.id}><strong>{movie.movie_name}</strong><span>{movie.category}</span></div>)}</div>}
        <a className="admin-view" href="/">VIEW PUBLIC CATALOG ↗</a>
      </section>}
      <p className="admin-security">Your dashboard password is stored only in this browser's local storage and is sent over HTTPS. It is never included in the public movie catalog.</p>
      <button className="admin-clear" type="button" onClick={clearToken}>CLEAR ADMIN SESSION</button>
      </section>
    </section>
    <footer><span>ARCHIVE / MOVIES</span><a href="/">RETURN TO CATALOG ↗</a></footer>
  </main>;
}

export default function App() {
  return window.location.pathname === '/admin' ? <AdminPanel /> : <MovieBrowser />;
}
