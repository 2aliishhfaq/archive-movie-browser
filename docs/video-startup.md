# Faster Archive video startup

- The MP4 range proxy fetches 2 MiB aligned cache blocks instead of 8 MiB, reducing the amount of origin data needed before a cold first range can be served.
- The internal cache path is versioned (`/__fmp4_cache_block_v2`) so old 8 MiB blocks cannot be mistaken for the new 2 MiB format.
- The player opts into `preload="auto"` when mounted, while the existing Archive.org direct fallback remains available if the Worker fails.
- The trade-off is more cache-block requests during long playback and seeks; repeat seeks inside a block remain edge-cache hits.

Validate cold-start and warm-cache range requests against a real Archive MP4, and never use production traffic to stress Archive.org.

- If Archive.org cannot provide a cacheable aligned range, the internal cache subrequest now returns a non-fatal 204 bypass; the public stream route falls back to transparent Archive.org range passthrough instead of generating a false internal 502 issue.
