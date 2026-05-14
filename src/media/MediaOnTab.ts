import browser from "webextension-polyfill";
import {InterceptedMediaResult, InterceptedMediaType} from "~/linkgrabber/LinkGrabberResponse";
import {run} from "~/utils/ScopeFunctions";
import {Resolution, Variant} from "hls-parser/types";
import * as HLSUtils from "~/media/HLSUtils";
import * as MultiMediaUtils from "~/media/MultiMediaUtils"
import _ from "lodash";
import HLS from "hls-parser"
import {getContentDisposition, getContentLength, getContentType} from "~/utils/HeaderUtils";
import {getFileExtension, getFileFromUrl, getFileNameWithoutExtension} from "~/utils/URLUtils";
import {getFileNameFromHeader} from "~/utils/ExtractFileNameFromHeader";

type MediaLinkToProcess = {
    pageIndex: number, // if this is not the same as current page index then we don't process it
    link: string,
    requestHeaders?: Record<string, string>,
    resolution?: Resolution,
    framerate?: number,
    bandwidth?: number,
    name?: string,
    fileExtension?: string,
    type?: InterceptedMediaType,
    isEncrypted?: boolean,
    duration?: number,
    size?: number,
    myVariant?: Variant,
    isProcessed: boolean, // when it is processed
}

export interface OnMedialListUpdated {
    onListUpdated(list: DownloadableMedia[]): void;
}

function applyHeadersToProcessingItem(mediaToProcess: MediaLinkToProcess, requestHeaders: Headers) {
    const headersRecord: Record<string, string> = {}
    requestHeaders.forEach((value, key) => {
        headersRecord[key] = value
    })
    mediaToProcess.requestHeaders = headersRecord
    return headersRecord
}

export class MediaOnTab {
    private currentMediaToProcess: Record<string, MediaLinkToProcess> = {}
    private isClosed = false
    private pageIndex = 0

    public constructor(
        public tabId: number,
        private onMediaListUpdated: OnMedialListUpdated
    ) {
    }

    close(): void {
        this.reset()
        this.isClosed = true;
    }

    private isCanceled(
        mediaLinkToProcess: MediaLinkToProcess,
    ) {
        if (this.isClosed) {
            return true
        }
        return this.pageIndex !== mediaLinkToProcess.pageIndex;
    }

    reset() {
        this.pageIndex++
        this.currentMediaToProcess = {}
    }

    getOrCreateProcessingMedia(uri: string) {
        const current = this.currentMediaToProcess[uri]
        if (typeof current === "object") {
            return current;
        }

        const newObject: MediaLinkToProcess = {
            link: uri,
            pageIndex: this.pageIndex,
            isProcessed: false,
        };
        this.currentMediaToProcess[uri] = newObject;
        return newObject
    }

    async process(
        mediaResult: InterceptedMediaResult
    ) {
        if (this.isAlreadyProcessed(mediaResult.url)) {
            return
        }

        switch (mediaResult.mediaType) {
            case "hls":
                await this.processHLS(
                    mediaResult.url,
                    mediaResult.requestHeaders
                )
                break
            case "http":
                await this.processHttp(
                    mediaResult.url,
                    mediaResult.requestHeaders,
                    mediaResult.responseHeaders,
                )
                break;
        }
    }

    private async processHttp(
        url: string, requestHeaders: Headers, responseHeaders: Headers,
    ) {
        const mediaToProcess = this.getOrCreateProcessingMedia(url);
        if (mediaToProcess.isProcessed) {
            return
        }
        mediaToProcess.isProcessed = true;
        mediaToProcess.type = "http"
        applyHeadersToProcessingItem(mediaToProcess, requestHeaders)
        let filenameWithExtension: string | null = null;
        let extension: string | null = null;
        const contentDisposition = getContentDisposition(responseHeaders);
        if (contentDisposition) {
            filenameWithExtension = getFileNameFromHeader(contentDisposition)
        }
        if (!filenameWithExtension) {
            filenameWithExtension = getFileFromUrl(url)
        }
        if (filenameWithExtension) {
            extension = getFileExtension(filenameWithExtension)
        }
        if (!extension) {
            const contentType = getContentType(responseHeaders)
            extension = MultiMediaUtils.getExtensionFromContentTypeOrUrl(contentType, url)
        }
        if (!extension) {
            // no extension ignore it
            return
        }
        mediaToProcess.fileExtension = extension
        if (filenameWithExtension) {
            mediaToProcess.name = getFileNameWithoutExtension(filenameWithExtension)
        }
        mediaToProcess.size = getContentLength(responseHeaders) ?? undefined
        this.onMediaProcessed(mediaToProcess)
    }

    private async processHLS(url: string, requestHeaders: Headers) {
        const mediaToProcess = this.getOrCreateProcessingMedia(url);
        if (mediaToProcess.isProcessed) {
            return
        }
        mediaToProcess.isProcessed = true // even if it fails!
        mediaToProcess.type = "hls"
        mediaToProcess.link = url
        mediaToProcess.fileExtension = "mp4"
        applyHeadersToProcessingItem(mediaToProcess, requestHeaders)
        if (!mediaToProcess.name) {
            const urlFilename = getFileFromUrl(url)
            if (urlFilename) {
                mediaToProcess.name = getFileNameWithoutExtension(urlFilename)
            }
        }
        await this.onMediaProcessed(mediaToProcess)

        const response = await fetchHlsContent(
            url,
            requestHeaders,
            (await this.getTab())?.url ?? undefined,
        );
        
        if (!response.success) {
            console.warn(`[HLS_SNIFF] Failed to fetch HLS content for: ${url}. Error: ${response.error}`);
            return
        }
        const content = response.content;
        if (content == null) {
            return
        }
        const playlist = this.parseHLS(content)
        if (playlist == null) {
            return
        }

        if (playlist.isMasterPlaylist) {
            const playListEncrypted = HLSUtils.isPlayListEncrypted(playlist);
            for (let variant of playlist.variants) {
                const newRequest = run(() =>
                    resolveVariantUrl(new Request(url, {headers: requestHeaders}), variant.uri)
                )
                const processingMedia = this.getOrCreateProcessingMedia(newRequest.url);

                if (playListEncrypted) {
                    processingMedia.isEncrypted = true
                    continue
                }
                processingMedia.myVariant = variant
                if (!processingMedia.name && typeof variant.name === "string" && variant.name.trim()) {
                    processingMedia.name = variant.name.trim()
                }
            }
            if (playListEncrypted) {
                return
            }
            playlist.variants.forEach(variant => {
                    const newRequest = run(() =>
                        resolveVariantUrl(new Request(url, {headers: requestHeaders}), variant.uri)
                    )
                this.processHLS(newRequest.url, newRequest.headers)
                }
            )
        } else {
            if (playlist.segments.length == 0) {
                return // empty list?
            }
            const isEncrypted = HLSUtils.isMediaPlayListEncrypted(playlist);
            if (isEncrypted) {
                return;
            }

            const filename = getFileFromUrl(playlist.segments[0].uri)
            let extension = filename && getFileExtension(filename)
            
            // Modern HLS often uses .m4s (CMAF), .mp4 or even no extension for segments.
            // We should be more permissive here. If it's a valid media playlist, it's HLS.
            const allowedExtensions = ["ts", "m4s", "mp4", "aac", "m4a", "m4v", "m2ts"];
            if (!extension || !allowedExtensions.includes(extension.toLowerCase())) {
                // If the segment extension is unknown or missing, default to 'ts' for the HLS item
                // as it's the most common and likely what the downloader/merger expects.
                extension = "ts";
            }

            mediaToProcess.fileExtension = extension
            mediaToProcess.type = "hls"
            mediaToProcess.link = url;
            mediaToProcess.duration = _.sumBy(
                playlist.segments, value => value.duration
            )
            mediaToProcess.bandwidth = mediaToProcess.myVariant?.bandwidth
            mediaToProcess.resolution = mediaToProcess.myVariant?.resolution
            mediaToProcess.framerate = mediaToProcess.myVariant?.frameRate
            mediaToProcess.isEncrypted = false;
            
            // Set name from URL if not already set
            if (!mediaToProcess.name) {
                const urlFilename = getFileFromUrl(url);
                if (urlFilename) {
                    mediaToProcess.name = getFileNameWithoutExtension(urlFilename);
                }
            }
            // it only needed for media playlist
            applyHeadersToProcessingItem(mediaToProcess, requestHeaders)
            this.onMediaProcessed(mediaToProcess)
        }
    }


    parseHLS(
        hlsContent: string,
    ) {
        return run(() => {
            try {
                return HLS.parse(hlsContent)
            } catch (e) {
                console.error(`[HLS_SNIFF] HLS.parse error:`, e);
                return null
            }
        })
    }

    private isAlreadyProcessed(link: string) {
        return this.currentMediaToProcess[link]?.isProcessed ?? false
    }

    async getTab() {
        try {
            return (await browser.tabs.get(this.tabId))
        } catch (e) {
            return null
        }
    }

    private async onMediaProcessed(
        media: MediaLinkToProcess
    ) {
        if (this.isCanceled(media)) {
            return
        }
        await this.reloadList()
    }

    private async reloadList() {
        const tab = await this.getTab()
        if (!tab) {
            return
        }
        const tabTitle = tab.title
        const tabUrl = tab.url
        if (!tabTitle || !tabUrl) {
            return
            // tab title is not defined
        }

        const downloadableMediaList = _
            .entries(this.currentMediaToProcess)
            .map(([_, value]) => {
                return createDownloadableMedia(
                    value,
                    {
                        pageTitle: tabTitle,
                        pageUrl: tabUrl,
                    });
            })
            .filter(i => i != null)
        this.onMediaListUpdated.onListUpdated(downloadableMediaList)
    }


}

export type DownloadableMedia = {
    type: InterceptedMediaType,
    uri: string,
    requestHeaders?: Record<string, string>,
    displayName?: string
    suggestedFullName?: string,
    duration?: string,
    bandwidth?: string,
    resolution?: string,
    extension?: string,
    size?: string,
}

function createBandwidthString(bandwidth: number) {
    const kbps = Math.round(bandwidth / 1000); // 500 kbps
    return `${kbps}kbps`
}

function createSizeString(size: number): string {
    if (size < 1024) return `${size} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let unitIndex = -1;
    do {
        size /= 1024;
        unitIndex++;
    } while (size >= 1024 && unitIndex < units.length - 1);
    return `${size.toFixed(2)} ${units[unitIndex]}`;
}

function createDownloadableMedia(
    mediaLinkToProcess: MediaLinkToProcess,
    pageInfo: {
        pageTitle: string
        pageUrl: string
    },
): DownloadableMedia | null {
    if (!mediaLinkToProcess.type) {
        // console.log("media doesn't have type", {mediaLinkToProcess})
        return null
    }
    if (mediaLinkToProcess.isEncrypted) {
        // console.log("media is encrypted", {mediaLinkToProcess})
        return null
    }
    if (!mediaLinkToProcess.fileExtension) {
        // console.log("media has no file extension", {mediaLinkToProcess})
        return null
    }

    const mediaProps = []
    const mediaName = sanitizeMediaName(mediaLinkToProcess.name)
    const nameFromUrl = sanitizeMediaName(extractMeaningfulNameFromUrl(mediaLinkToProcess.link))
    const pageTitle = sanitizeMediaName(pageInfo.pageTitle)
    const pageNameFromUrl = sanitizeMediaName(extractMeaningfulNameFromUrl(pageInfo.pageUrl))
    const name = chooseBestMediaName(mediaName, nameFromUrl, pageTitle, pageNameFromUrl)
    mediaProps.push(name)

    let resolutionString: string | undefined
    if (mediaLinkToProcess.resolution) {
        resolutionString = createResolutionString(mediaLinkToProcess.resolution);
        mediaProps.push(
            resolutionString
        )
    }
    if (mediaLinkToProcess.framerate) {
        mediaProps.push(
            `${mediaLinkToProcess.framerate}fps`
        )
    }

    let durationString: string | undefined = undefined
    if (typeof mediaLinkToProcess.duration == "number") {
        durationString = createDurationString(mediaLinkToProcess.duration)
    }
    let bandwidthString: string | undefined = undefined
    if (typeof mediaLinkToProcess.bandwidth == "number") {
        bandwidthString = createBandwidthString(mediaLinkToProcess.bandwidth)
    }
    let sizeString: string | undefined = undefined
    if (typeof mediaLinkToProcess.size == "number") {
        sizeString = createSizeString(mediaLinkToProcess.size)
    }
    if (!resolutionString && bandwidthString) {
        mediaProps.push(bandwidthString)
    }
    return {
        uri: mediaLinkToProcess.link,
        requestHeaders: mediaLinkToProcess.requestHeaders,
        displayName: name,
        suggestedFullName: buildSuggestedFileName(mediaProps, mediaLinkToProcess.fileExtension),
        type: mediaLinkToProcess.type,
        duration: durationString,
        extension: mediaLinkToProcess.fileExtension,
        size: sizeString,
        resolution: resolutionString,
        bandwidth: bandwidthString,
    }
}

function createResolutionString(resolution: Resolution) {
    if (resolution.height) {
        return `${resolution.height}p`
    }
    if (resolution.width) {
        return `${resolution.width}w`
    }
    return "unknown"
}


function createDurationString(duration: number) {
    const seconds = Math.floor(duration % 60)
    const minutes = Math.floor((duration / 60) % 60)
    const hours = Math.floor(duration / 3600)
    const m = minutes.toString().padStart(2, "0");
    const s = seconds.toString().padStart(2, "0");
    if (hours == 0) {
        return `${m}:${s}`
    } else {
        const h = hours.toString().padStart(2, "0");
        return `${h}:${m}:${s}`
    }
}


function resolveVariantUrl(
    request: Request, // manifest request
    variantUrl: string,
) {
    try {
        const parsed = new URL(variantUrl, request.url);
        const o: Request = new Request(parsed.toString())
        request.headers.forEach((value, key, _) => {
            o.headers.set(key, value);
        })
        return o
    } catch (e) {
        return new Request(variantUrl)
    }
}

async function fetchHlsContent(
    url: string,
    requestHeaders: Headers,
    tabUrl?: string,
) {
    const headers = new Headers()
    requestHeaders.forEach((value, key) => {
        headers.set(key, value)
    })
    if (tabUrl && !headers.has("Referer")) {
        headers.set("Referer", tabUrl)
    }
    try {
        const response = await fetch(url, {headers})
        if (!response.ok) {
            return { success: false, error: `Failed to fetch HLS content: ${response.status} ${response.statusText}` }
        }
        return { success: true, content: await response.text() }
    } catch (e) {
        return { success: false, error: `Network error: ${e}` }
    }
}

function buildSuggestedFileName(parts: Array<string | undefined>, extension: string) {
    const cleanParts = parts.filter((part): part is string => Boolean(part))
    return `${cleanParts.join(" - ") || "media"}.${extension}`
}

function chooseBestMediaName(...candidates: Array<string | undefined>) {
    for (const candidate of candidates) {
        if (candidate && !looksLikeOpaqueMediaName(candidate)) {
            return candidate
        }
    }
    return candidates.find(Boolean) ?? "media"
}

function extractMeaningfulNameFromUrl(url: string) {
    const fileName = getFileFromUrl(url)
    if (!fileName) {
        return undefined
    }
    return getFileNameWithoutExtension(fileName)
}

function sanitizeMediaName(input?: string | null) {
    if (!input) {
        return undefined
    }
    const value = input
        .replace(/\s+/g, " ")
        .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
        .replace(/[_-]{3,}/g, " ")
        .trim()
    return value || undefined
}

function looksLikeOpaqueMediaName(name: string) {
    const normalized = name.trim().toLowerCase()
    if (!normalized) {
        return true
    }
    if (["master", "index", "playlist", "video", "audio"].includes(normalized)) {
        return true
    }
    if (/^[a-f0-9-]{16,}$/.test(normalized)) {
        return true
    }
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(normalized)) {
        return true
    }
    if (/^(seg|chunk|stream|playlist|index|media)[-_]?\d*$/i.test(normalized)) {
        return true
    }
    return false
}
