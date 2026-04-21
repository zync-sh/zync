import { useEffect, useState } from 'react';

export interface Contributor {
    id: number;
    login: string;
    html_url: string;
    avatar_url: string;
    contributions?: number;
}

interface UseAboutStatsOptions {
    isOpen: boolean;
    activeTab: string;
}

interface CachedAboutData {
    contributors: Contributor[];
    stars: number;
    timestamp: number;
}

const CACHE_KEY = 'zync-about-data';
const CACHE_TTL_MS = 60 * 60 * 1000;

function safeReadCache(): CachedAboutData | null {
    if (typeof window === 'undefined') return null;

    try {
        const cachedParams = window.localStorage.getItem(CACHE_KEY);
        if (!cachedParams) return null;
        const parsed = JSON.parse(cachedParams) as Partial<CachedAboutData>;
        if (
            !Array.isArray(parsed.contributors)
            || typeof parsed.stars !== 'number'
            || typeof parsed.timestamp !== 'number'
        ) {
            return null;
        }
        return {
            contributors: parsed.contributors,
            stars: parsed.stars,
            timestamp: parsed.timestamp,
        };
    } catch {
        return null;
    }
}

function safeWriteCache(payload: CachedAboutData) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch (error) {
        console.warn('Failed to cache about data', error);
    }
}

async function parseJsonOrThrow<T>(response: Response, label: string): Promise<T> {
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`${label} fetch failed (${response.status}): ${body || response.statusText}`);
    }
    return response.json() as Promise<T>;
}

export function useAboutStats({ isOpen, activeTab }: UseAboutStatsOptions) {
    const [contributors, setContributors] = useState<Contributor[]>([]);
    const [stars, setStars] = useState<number | null>(null);

    useEffect(() => {
        if (!(isOpen && activeTab === 'about')) return;

        const now = Date.now();
        const cached = safeReadCache();
        if (cached && now - cached.timestamp < CACHE_TTL_MS) {
            setContributors(cached.contributors);
            setStars(cached.stars);
            return;
        }

        const controller = new AbortController();

        Promise.all([
            fetch('https://api.github.com/repos/zync-sh/zync/contributors', { signal: controller.signal }),
            fetch('https://api.github.com/repos/zync-sh/zync', { signal: controller.signal }),
        ])
            .then(async ([contribRes, repoRes]) => {
                const contribData = await parseJsonOrThrow<Contributor[]>(contribRes, 'Contributors');
                const repoData = await parseJsonOrThrow<{ stargazers_count?: number | null }>(repoRes, 'Repo');
                if (controller.signal.aborted) return;

                const normalizedContributors = Array.isArray(contribData) ? contribData : [];
                const normalizedStars = repoData.stargazers_count ?? 0;

                setContributors(normalizedContributors);
                setStars(normalizedStars);
                safeWriteCache({
                    contributors: normalizedContributors,
                    stars: normalizedStars,
                    timestamp: now,
                });
            })
            .catch((error: unknown) => {
                if (
                    controller.signal.aborted
                    || (error instanceof DOMException && error.name === 'AbortError')
                ) {
                    return;
                }
                console.error('Failed to load about stats', error);
            });

        return () => {
            controller.abort();
        };
    }, [isOpen, activeTab]);

    return { contributors, stars };
}
