import {initializeOptions} from "~/contextmenus/ContextMenus";
import * as backend from "~/backend/Backend"
import {run} from "~/utils/ScopeFunctions";
import {redirectDownloadLinksToMe} from "~/linkgrabber/LinkGrabber";
import * as Configs from "~/configs/Config";
import {addDownload, getHeadersForUrls} from "~/background/actions";
import {Disposable} from "~/utils/disposable";
import {keepListeningToEvents} from "~/utils/extension-api";
import {IS_MV3} from "~/utils/ManifestUtil";
import {MediaRegistry} from "~/media/MediaRegistry";
import {isUrlBlacklisted} from "~/utils/UrlBlocker";

function receiveMessageFromContentScripts(mediaRegistry: MediaRegistry) {
    browser.runtime.onMessage.addListener(async (msg, sender) => {
        try {
            if (msg && msg.type === "add_download") {
                return await addDownload(msg.data)
            }
            if (msg && msg.type === "test_port") {
                return await backend.ping(msg.data)
            }
            if (msg && msg.type === "show_log") {
                console.log(...(msg.data ?? []))
                return null
            }
            if (msg && msg.type === "get_headers") {
                return await getHeadersForUrls(msg.data)
            }
            if (msg && msg.type === "request_pending_media") {
                if (isUrlBlacklisted(sender?.tab?.url)) {
                    return []
                }
                const tabId = sender?.tab?.id ?? -1
                const candidateUrl = typeof msg.url === "string" ? msg.url : null
                const current = tabId >= 0 ? mediaRegistry.getCurrentMediaForTab(tabId, candidateUrl) : []
                if (current.length > 0) {
                    return current
                }
                const key = `abdm_pending_media_${tabId}`
                const stored = await browser.storage.local.get(key)
                if (stored[key] && Array.isArray(stored[key]) && stored[key].length > 0) {
                    return stored[key]
                }
                // fallback: try origin-based pending entries and migrate them to the tab-specific key
                try {
                    const origin = sender?.tab?.url ? (new URL(sender.tab.url)).origin : null
                    if (origin) {
                        const originKey = `abdm_pending_media_origin_${origin}`
                        const originStored = await browser.storage.local.get(originKey)
                        const arr = originStored[originKey] ?? []
                        if (arr && arr.length > 0) {
                            // move to tab-specific key so MediaRegistry/content-script can use it
                            const rec: Record<string, any> = {}
                            rec[key] = arr
                            await browser.storage.local.set(rec)
                            await browser.storage.local.remove(originKey)
                            console.log('[background] migrated pending origin media to tab', {tabId, origin})
                            return arr
                        }
                    }
                } catch (e) {
                    console.error('background:request_pending_media origin fallback error', e)
                }
                return []
            }
            if (msg && msg.type === "hover_near_media") {
                if (isUrlBlacklisted(sender?.tab?.url)) {
                    return { items: [] }
                }
                const tabId = sender?.tab?.id ?? -1
                const items = tabId >= 0
                    ? mediaRegistry.getCurrentMediaForTab(tabId, typeof msg.url === "string" ? msg.url : null)
                    : []
                return { items }
            }
        } catch (e) {
            console.error("background:onMessage error", e)
        }
        return null
    })
}

run(async () => {
    const disposable= new Disposable()
    try {
        if (IS_MV3){
            disposable.add(keepListeningToEvents())
        }
        await Configs.boot()
        await initializeOptions()
        const mediaRegistry = redirectDownloadLinksToMe()
        receiveMessageFromContentScripts(mediaRegistry)
        console.log("ab dm extension loaded successfully")
    } catch (e) {
        console.log("extension loading fail", e)
        // dispose resources if we can't serve the user well
        disposable.dispose()
    }
})
