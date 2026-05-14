// Mapping of common media content types to file extensions
const CONTENT_TYPE_TO_EXTENSION: Record<string, string> = {
    // Video
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/ogg": "ogv",
    "video/quicktime": "mov",
    "video/x-msvideo": "avi",
    "video/x-flv": "flv",
    "video/mpeg": "mpeg",

    // Streaming / segments
    "video/MP2T": "ts",      // HLS segments
    "application/vnd.apple.mpegurl": "m3u8", // HLS playlist
    "application/x-mpegURL": "m3u8",         // HLS playlist
    "video/mp2t": "ts",       // lowercase variant

    // Audio
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/x-flac": "flac",

    // Streaming / segments
    "audio/ts": "ts",
    "audio/m4s": "m4s"
};

/**
 * Get file extension from content type.
 * Returns extension without dot, or null if unknown.
 */
export function getExtensionFromContentType(contentType: string): string | null {
    if (!contentType) return null;
    const type = contentType.toLowerCase().split(";")[0].trim();
    return CONTENT_TYPE_TO_EXTENSION[type] || null;
}

/**
 * Get extension using content-type first, then fall back to url suffix.
 * This helps when servers return generic content-types like text/html for m3u8.
 */
export function getExtensionFromContentTypeOrUrl(contentType: string | null | undefined, url?: string): string | null {
    let ext = null
    if (contentType) {
        ext = getExtensionFromContentType(contentType)
        if (ext) return ext
    }
    if (!url) return null
    try {
        const u = url.split(/[?#]/)[0]
        const m = u.match(/\.([a-z0-9]{2,8})$/i)
        if (m) return m[1].toLowerCase()
        // special-case m3u8 when url contains .m3u8 but no clear suffix
        if (u.toLowerCase().includes('.m3u8')) return 'm3u8'
    } catch (e) {}
    return null
}
