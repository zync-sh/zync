/**
 * Icon Caching Logic
 * Based on Mullayam's strategy in terminus-web
 */

const CACHE_NAME = "zync-icons-v1";
const BLOB_URL_MAP = new Map<string, string>();
const IN_FLIGHT_MAP = new Map<string, Promise<string>>();

/**
 * Returns a cached Blob URL for the given icon URL.
 */
export async function getCachedIcon(url: string): Promise<string> {
    // 1. Check in-memory map first (Fastest)
    if (BLOB_URL_MAP.has(url)) {
        return BLOB_URL_MAP.get(url)!;
    }

    // 2. Dedup concurrent requests for the same icon
    if (IN_FLIGHT_MAP.has(url)) {
        return IN_FLIGHT_MAP.get(url)!;
    }

    const work = _fetchAndCache(url);
    IN_FLIGHT_MAP.set(url, work);

    try {
        return await work;
    } finally {
        IN_FLIGHT_MAP.delete(url);
    }
}

async function _fetchAndCache(url: string): Promise<string> {
    try {
        const cache = await caches.open(CACHE_NAME);

        // A. Check browser Cache Storage
        const match = await cache.match(url);
        if (match) {
            const blob = await match.blob();
            const blobUrl = URL.createObjectURL(blob);
            BLOB_URL_MAP.set(url, blobUrl);
            return blobUrl;
        }

        // B. Fetch from network
        const response = await fetch(url);
        if (!response.ok) return url; // Fallback to raw URL

        // Clone before consuming (needed for Cache API)
        const clone = response.clone();
        await cache.put(url, clone);

        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        BLOB_URL_MAP.set(url, blobUrl);
        return blobUrl;
    } catch (error) {
        if (import.meta.env.DEV) {
            console.warn('[iconCache] fetch failed:', url, error);
        }
        return url; // Final fallback
    }
}

/**
 * Pre-warm the cache for a list of URLs
 */
export function prewarmIcons(urls: string[]) {
    urls.forEach(url => getCachedIcon(url).catch(() => {}));
}
