-- Store multiple independently validated video sources for a single poster/movie.
-- The legacy movie_link column remains the first episode URL for compatibility.
ALTER TABLE public.movies
  ADD COLUMN IF NOT EXISTS movie_links jsonb NOT NULL DEFAULT '[]'::jsonb;
