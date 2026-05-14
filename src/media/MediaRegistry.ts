import browser from "webextension-polyfill";
import {InterceptedMediaResult} from "~/linkgrabber/LinkGrabberResponse";
import {OnMediaInterceptedFromRequestListener} from "~/media/OnMediaInterceptedFromRequestListener";
import {DownloadableMedia, MediaOnTab} from "~/media/MediaOnTab";
import * as HLSUtils from "~/media/HLSUtils"

export class MediaRegistry implements OnMediaInterceptedFromRequestListener {
    private readonly tabsMap: Record<number, MediaOnTab | undefined> = {}
    private readonly currentLists: Record<number, DownloadableMedia[] | undefined> = {}

    constructor() {
        HLSUtils.parseHLSSilently()
    }

    private getOrCreateMediaInPage(
        tabId: number
    ): MediaOnTab {
        let result = this.tabsMap[tabId]

        if (!result) {
            result = new MediaOnTab(tabId, {
                onListUpdated: (list: DownloadableMedia[]) => {
                    this.setCurrentMediaForTab(tabId, list)
                    onDownloadableMediaProcessed(tabId, list)
                },
            })
            this.tabsMap[tabId] = result
        }
        return result
    }

    boot() {
        browser.tabs.onRemoved.addListener(
            (tabId, _) => {
                const page = this.tabsMap[tabId]
                if (!page) {
                    run(async () => {
                        await browser.storage.local.remove(`abdm_pending_media_${tabId}`)
                    })
                    return
                }
                page.close()
                delete this.tabsMap[tabId]
                delete this.currentLists[tabId]
                run(async () => {
                    await browser.storage.local.remove(`abdm_pending_media_${tabId}`)
                })
            }
        )
        browser.tabs.onUpdated.addListener(
            (tabId, changeInfo, tab) => {
                const mediaOnTab = this.tabsMap[tabId]
                if (changeInfo.status === "loading" || changeInfo.url) {
                    mediaOnTab?.reset()
                    delete this.currentLists[tabId]
                    run(async () => {
                        await browser.storage.local.remove(`abdm_pending_media_${tabId}`)
                    })
                }
                if (changeInfo.status === "complete" && tab.url) {
                    run(async () => {
                        const originKey = `abdm_pending_media_origin_${new URL(tab.url).origin}`
                        // origin cache is only a short-lived fallback; clean it after the new page is loaded
                        await browser.storage.local.remove(originKey)
                    })
                }
            }
        )
    }

    getCurrentMediaForTab(tabId: number, candidateUrl?: string | null): DownloadableMedia[] {
        const list = this.sortAndDedupeMedia(this.currentLists[tabId] ?? [])
        if (!candidateUrl || candidateUrl.startsWith("blob:")) {
            return this.preferUsefulMedia(list)
        }
        const normalizedCandidate = candidateUrl.toLowerCase()
        const exact = list.filter((item) => item.uri.toLowerCase() === normalizedCandidate)
        if (exact.length > 0) {
            return this.preferUsefulMedia(exact)
        }
        const soft = list.filter((item) => item.uri.toLowerCase().includes(normalizedCandidate) || normalizedCandidate.includes(item.uri.toLowerCase()))
        return this.preferUsefulMedia(soft.length > 0 ? soft : list)
    }

    setCurrentMediaForTab(tabId: number, downloadableMedia: DownloadableMedia[]) {
        this.currentLists[tabId] = this.sortAndDedupeMedia(downloadableMedia)
    }

    private preferUsefulMedia(items: DownloadableMedia[]) {
        const hls = items.filter((item) => item.type === "hls")
        if (hls.length > 0) {
            const variantHls = hls.filter((item) => looksLikeVariantPlaylist(item.uri))
            if (variantHls.length > 0) {
                return variantHls
            }
            return hls
        }
        const nonPreview = items.filter((item) => !looksLikePreviewMedia(item))
        return nonPreview.length > 0 ? nonPreview : items
    }

    private sortAndDedupeMedia(items: DownloadableMedia[]) {
        const byKey = new Map<string, DownloadableMedia>()
        for (const item of items) {
            const key = `${item.type}|${item.uri}`
            const prev = byKey.get(key)
            if (!prev || scoreMedia(item) > scoreMedia(prev)) {
                byKey.set(key, item)
            }
        }
        return [...byKey.values()].sort((a, b) => scoreMedia(b) - scoreMedia(a))
    }


    async onMediaDetected(tabId: number, mediaResult: InterceptedMediaResult) {
        if (tabId < 0) {
            return
        }
        await (
            this
                .getOrCreateMediaInPage(tabId)
                .process(mediaResult)
        )
    }
}

async function onDownloadableMediaProcessed(
    tabId: number,
    downloadableMedia: DownloadableMedia[],
) {
    try {
        const key = `abdm_pending_media_${tabId}`
        const record: Record<string, DownloadableMedia[]> = {}
        record[key] = downloadableMedia
        await browser.storage.local.set(record)
    } catch (err) {
        console.error("[MEDIA_REGISTRY] failed to store pending media", err, {tabId})
    }
}

function scoreMedia(item: DownloadableMedia) {
    let score = 0
    if (item.type === "hls") score += 1000
    if (item.requestHeaders && Object.keys(item.requestHeaders).length > 0) score += 300
    if (item.resolution) score += 200
    if (item.bandwidth) score += 100
    if (item.duration) score += 40
    if (item.size) score += 20
    if (looksLikeVariantPlaylist(item.uri)) score += 120
    if (looksLikeMasterPlaylist(item.uri)) score -= 80
    if (looksLikePreviewMedia(item)) score -= 500
    return score
}

function looksLikePreviewMedia(item: DownloadableMedia) {
    const text = `${item.displayName ?? ""} ${item.suggestedFullName ?? ""} ${item.uri}`.toLowerCase()
    return text.includes("preview") || text.includes("/preview.") || text.endsWith("preview.mp4")
}

function looksLikeMasterPlaylist(uri: string) {
    return /\/playlist\.m3u8(?:$|\?)/i.test(uri) || /\/master\.m3u8(?:$|\?)/i.test(uri)
}

function looksLikeVariantPlaylist(uri: string) {
    return /\/\d{3,4}x\d{3,4}\/.*\.m3u8(?:$|\?)/i.test(uri) || /\/video\.m3u8(?:$|\?)/i.test(uri)
}
