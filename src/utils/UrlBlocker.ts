import urlMatch from "match-url-wildcard"
import * as Configs from "~/configs/Config"

/**
 * Unified URL matching against a list of patterns.
 * Supports wildcard matching, hostname matching, and substring fallback.
 */
export function matchesUrlPattern(url: string, patterns: string[]) {
    if (patterns.length === 0) {
        return false
    }
    if (urlMatch(url, patterns)) {
        return true
    }
    try {
        const parsed = new URL(url)
        const candidates = [
            url,
            parsed.origin,
            parsed.hostname,
            parsed.hostname.replace(/^www\./i, ""),
        ]
        return candidates.some(candidate => candidate && (
            urlMatch(candidate, patterns)
            || patterns.some(pattern => {
                const normalizedPattern = pattern.trim().toLowerCase()
                if (!normalizedPattern) {
                    return false
                }
                // Strip wildcards and scheme separators for substring matching
                const cleanPattern = normalizedPattern.replace(/[*?]/g, "").replace(/^:\/\/|:\/?/g, "").trim()
                if (!cleanPattern) {
                    return false
                }
                return candidate.toLowerCase().includes(cleanPattern)
            })
        ))
    } catch (e) {
        return false
    }
}

/**
 * Check if a URL matches any user-configured blacklistedUrls.
 */
export function isUrlBlacklisted(url: string | undefined | null) {
    if (!url) {
        return false
    }
    const patterns = Configs.getLatestConfig().blacklistedUrls ?? []
    if (patterns.length === 0) {
        return false
    }
    return matchesUrlPattern(url, patterns)
}
