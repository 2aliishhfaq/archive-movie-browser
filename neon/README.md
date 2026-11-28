# Neon database migrations

Apply these SQL files to the Reelbox Neon project (not the local SQLite/D1 test database).

- `migrations/0007_movie_episodes.sql` adds `movies.movie_links` as a JSONB array. Existing `movie_link` remains the first episode URL for backward compatibility.

The production Neon column was added idempotently before deploying the application code.
