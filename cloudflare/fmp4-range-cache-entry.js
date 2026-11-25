import { WorkerEntrypoint } from "cloudflare:workers";
import { createFmp4CacheBlock } from "./archive-movie-proxy.js";

export class Fmp4RangeCache extends WorkerEntrypoint {
  async fetch(request) {
    return createFmp4CacheBlock(request);
  }
}
