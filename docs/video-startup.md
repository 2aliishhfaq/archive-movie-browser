# Faster Archive video startup

- The MP4 range proxy fetches a 1 MiB startup block first, then fetches 8 MiB cache blocks on demand for the rest of the video. This reduces cold-start wait while keeping later playback efficient.
- The internal cache path is versioned (`/__fmp4_cache_block_v3`) so old 2 MiB blocks cannot be mistaken for the new 1 MiB + 8 MiB format.
- The player opts into `preload="auto"` when mounted, while the existing Archive.org direct fallback remains available if the Worker fails.
- The first 1 MiB is fetched independently; subsequent 8 MiB blocks are pulled only as the browser requests more video data. Playback can begin as soon as the first bytes are available, without waiting for the full movie.

Validate cold-start and warm-cache range requests against a real Archive MP4, and never use production traffic to stress Archive.org.

- If Archive.org cannot provide a cacheable aligned range, the internal cache subrequest now returns a non-fatal 204 bypass; the public stream route falls back to transparent Archive.org range passthrough instead of generating a false internal 502 issue.
