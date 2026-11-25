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
      <span className="top-note">INDEPENDENT FILM ARCHIVE</span>
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
  const [token, setToken] = useState(() => window.localStorage.getItem('archive-admin-token') || '');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Feature Films');
  const [limit, setLimit] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [manualMovie, setManualMovie] = useState({ movie_name: '', category: '', poster: '', movie_link: '' });
  const [manualBusy, setManualBusy] = useState(false);
  const [manualMessage, setManualMessage] = useState('');

  async function publishMovie(event) {
    event.preventDefault();
    setManualMessage('');
    if (!token.trim()) { setError('Enter your admin token to continue.'); return; }
    setManualBusy(true);
    window.localStorage.setItem('archive-admin-token', token.trim());
    try {
      const response = await fetch('/api/movies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token.trim() },
        body: JSON.stringify(manualMovie),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not publish movie.');
      setManualMessage('Published successfully. This movie is now visible in the public catalog.');
      setManualMovie({ movie_name: '', category: '', poster: '', movie_link: '' });
    } catch (err) {
      setManualMessage(err.message || 'Publish failed.');
    } finally {
      setManualBusy(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setResult(null);
    if (!token.trim()) { setError('Enter your admin token to continue.'); return; }
    setBusy(true);
    window.localStorage.setItem('archive-admin-token', token.trim());
    try {
      const response = await fetch('/api/movies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token.trim() },
        body: JSON.stringify({ action: 'import', query, category, limit }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Import request failed.');
      setResult(data);
    } catch (err) {
      setError(err.message || 'Import failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function clearToken() {
    window.localStorage.removeItem('archive-admin-token');
    setToken('');
    setResult(null);
    setError('');
  }

  return <main className="admin-shell">
    <header className="topbar">
      <a className="brand" href="/" aria-label="Back to Archive Movies"><span className="brand-mark">A</span><span>ARCHIVE<span className="brand-light"> / ADMIN</span></span></a>
      <a className="admin-back" href="/">← BACK TO CATALOG</a>
    </header>
    <section className="admin-content">
      <p className="eyebrow">COLLECTION MANAGEMENT</p>
      <h1>Bring films<br/><em>into the archive.</em></h1>
      <p className="admin-copy">Search Internet Archive movie records and import playable files into your Neon catalog. Duplicate links and items without supported video files are skipped.</p>
      <section className="dashboard-section admin-access">
        <div className="dashboard-section-heading">
          <p className="eyebrow">ADMIN ACCESS</p>
          <h2>Admin session</h2>
          <p>Enter your admin token once. It will be remembered on this device for future visits.</p>
        </div>
        <form className="admin-form" onSubmit={event => { event.preventDefault(); window.localStorage.setItem('archive-admin-token', token.trim()); setError(''); }}>
          <label>ADMIN TOKEN
            <input type="password" autoComplete="current-password" value={token} onChange={e => { setToken(e.target.value); window.localStorage.setItem('archive-admin-token', e.target.value.trim()); }} placeholder="MOVIES_ADMIN_TOKEN" required />
          </label>
          <button className="admin-submit" type="submit">SAVE ADMIN SESSION</button>
        </form>
      </section>
      <section className="dashboard-section">
        <div className="dashboard-section-heading">
          <p className="eyebrow">YOUR MOVIE LIBRARY</p>
          <h2>Add your own movie</h2>
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
          <button className="admin-submit" type="submit" disabled={manualBusy}>{manualBusy ? 'PUBLISHING…' : 'PUBLISH TO USER CATALOG ↗'}</button>
        </form>
        {manualMessage && <div className="admin-message" role="status">{manualMessage}</div>}
        <p className="admin-security">The video must already be hosted at a public HTTPS address. A file on your PC cannot stream until it is uploaded to a video host or storage such as Cloudflare R2.</p>
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
      <p className="admin-security">Your admin token is stored only in this browser's local storage and is sent over HTTPS. It is never included in the public movie catalog.</p>
      <button className="admin-clear" type="button" onClick={clearToken}>CLEAR ADMIN SESSION</button>
      </section>
    </section>
    <footer><span>ARCHIVE / MOVIES</span><a href="/">RETURN TO CATALOG ↗</a></footer>
  </main>;
}

export default function App() {
  return window.location.pathname === '/admin' ? <AdminPanel /> : <MovieBrowser />;
}
