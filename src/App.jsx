import React, { useEffect, useMemo, useState } from 'react';

const PROXY = 'https://archive-movie-proxy.2aliishhfaq.workers.dev/';
const imageFallback = 'https://placehold.co/480x720/171717/f5f5f5?text=No+Poster';

function proxyUrl(source) {
  return PROXY + '?url=' + encodeURIComponent(source);
}

export default function App() {
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
    const onKey = e => { if (e.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return <main className="shell">
    <header className="topbar">
      <a className="brand" href="/" aria-label="Archive Movie Browser home"><span className="brand-mark">A</span><span>ARCHIVE<span className="brand-light"> / MOVIES</span></span></a>
      <span className="top-note">INDEPENDENT FILM ARCHIVE</span>
    </header>
    <section className="hero">
      <p className="eyebrow">A WINDOW INTO FILM HISTORY</p>
      <h1>Films worth<br/><em>finding.</em></h1>
      <p className="hero-copy">Explore films preserved by the Internet Archive. Discover a forgotten favourite or find something entirely new.</p>
      <div className="search-row">
        <label className="search-box"><span aria-hidden="true">⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search films..." aria-label="Search films"/></label>
        <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Filter by category"><option value="">All categories</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select>
      </div>
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
    <footer><span>ARCHIVE / MOVIES</span><a href="https://archive.org" target="_blank" rel="noreferrer">PRESERVED BY THE INTERNET ARCHIVE ↗</a></footer>
    {selected && <div className="modal-backdrop" role="presentation" onClick={()=>setSelected(null)}><section className="player-modal" role="dialog" aria-modal="true" aria-label={selected.movie_name} onClick={e=>e.stopPropagation()}>
      <button className="close" onClick={()=>setSelected(null)} aria-label="Close player">×</button>
      <div className="video-frame"><video controls autoPlay playsInline poster={selected.poster || undefined} src={proxyUrl(selected.movie_link)}><a href={selected.movie_link}>Open video at Internet Archive</a></video></div>
      <div className="player-info"><div><p className="eyebrow">{selected.category || 'ARCHIVE FILM'}</p><h2>{selected.movie_name}</h2></div><a href={selected.movie_link} target="_blank" rel="noreferrer">SOURCE ↗</a></div>
    </section></div>}
  </main>;
}
