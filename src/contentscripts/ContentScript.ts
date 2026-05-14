import {getLinksFromSelection} from "~/utils/LinkExtractor";
import * as selectionPopup from "~/popup/selection/SelectionPopup";
import * as MediaPopup from "~/popup/media/MediaSelectionPopup";
import {debounce} from "~/utils/Debaunce";
import * as mousePosition from "~/utils/MouseUtil"
import * as Configs from "~/configs/Config"
import {run} from "~/utils/ScopeFunctions";
import browser from "webextension-polyfill";
import {createAlertStringForMyExtension} from "~/utils/AlertMessageCreator";
import {addDownloads} from "~/contentscripts/AddDownloads";
import {DownloadableMedia} from "~/media/MediaOnTab";
import {isUrlBlacklisted} from "~/utils/UrlBlocker";

const showPopupDelayed = debounce(500)

async function checkAndReportLinks() {
    const selection = window.getSelection();
    if (selection == null) {
        alert(createAlertStringForMyExtension(browser.i18n.getMessage("popup_alert_nothing_selected")))
        return
    }
    let downloadItems = getLinksFromSelection(selection)
    if (downloadItems.length == 0) {
        alert(createAlertStringForMyExtension(browser.i18n.getMessage("popup_alert_no_link_detected")))
        return
    }
    await addDownloads(downloadItems)
}

let lastSelectionConsumed = true
let lastMediaSignature = ""
let lastDetectedLocation = location.href

function isPopupBlacklistedForCurrentPage() {
    return isUrlBlacklisted(location.href)
}

function shouldCreatePopup() {
    return lastSelectionConsumed && Configs.getLatestConfig().popupEnabled
}

function handleDetectedMedia(items: DownloadableMedia[] | undefined | null) {
    if (isPopupBlacklistedForCurrentPage()) {
        return
    }
    if (!Array.isArray(items) || items.length === 0) {
        return
    }
    const signature = items.map((item) => `${item.type}|${item.uri}|${item.suggestedFullName ?? ""}`).join("||")
    if (signature === lastMediaSignature) {
        return
    }
    lastMediaSignature = signature
    try {
        console.info("[MEDIA_POPUP] showing detected media", items.map(item => ({
            type: item.type,
            uri: item.uri,
        })))
        let anchor: HTMLElement | null = null
        try {
            const uris = new Set(items.map((p) => p.uri))
            const candidates = Array.from(document.querySelectorAll<HTMLMediaElement | HTMLImageElement>("video, audio, img"))
            for (const el of candidates) {
                const src = (el instanceof HTMLImageElement) ? (el.currentSrc || el.src) : (el.currentSrc || (el as HTMLMediaElement).src)
                if (src && uris.has(src)) {
                    anchor = el as HTMLElement
                    break
                }
            }
        } catch (e) {
            // ignore anchor matching failures and still show the popup
        }
        MediaPopup.updatePopup(items, anchor, true)
    } catch (e) {
        console.error("[CONTENT_SCRIPT] MediaPopup.updatePopup error", e)
    }
}

async function refreshDetectedMedia(candidateUrl?: string | null) {
    try {
        if (isPopupBlacklistedForCurrentPage()) {
            lastMediaSignature = ""
            MediaPopup.updatePopup([], null, false)
            return
        }
        if (location.href !== lastDetectedLocation) {
            lastDetectedLocation = location.href
            lastMediaSignature = ""
            MediaPopup.updatePopup([], null, false)
        }
        const pending = await browser.runtime.sendMessage({
            type: "request_pending_media",
            url: candidateUrl ?? undefined,
        })
        if (Array.isArray(pending) && pending.length > 0) {
            handleDetectedMedia(pending)
        } else if (!document.querySelector("video, audio, img")) {
            lastMediaSignature = ""
            MediaPopup.updatePopup([], null, false)
        }
    } catch (e) {
        // ignore background messaging failures
    }
}

run(async () => {
    await Configs.boot()
    mousePosition.boot()
    // start hover-based media detection to show popup near hovered media
    try {
        MediaPopup.initHoverDetector()
    } catch (e) {
        console.error("[CONTENT_SCRIPT] initHoverDetector failed", e)
    }
    // ask background for any pending downloadable media that was stored as a fallback
    try {
        await refreshDetectedMedia()
    } catch (e) {
        // ignore
    }
    selectionPopup.setOnPopupClicked(async () => {
        checkAndReportLinks()
    })
    MediaPopup.setItemClickListener((media) => {
        const addDownloadType = media.type
        addDownloads([
            {
                link: media.uri,
                suggestedName: media.suggestedFullName ?? "",
                type: addDownloadType,
                downloadPage: location.href,
                headers: media.requestHeaders ?? null,
                description: null
            }
        ])
        MediaPopup.toggleList(false)
    })

    document.addEventListener("selectionchange", () => {
        lastSelectionConsumed = true
    })
    window.setInterval(() => {
        if (document.visibilityState !== "visible") {
            return
        }
        const mediaEl = document.querySelector<HTMLVideoElement | HTMLAudioElement>("video, audio")
        const candidateUrl = mediaEl ? (mediaEl.currentSrc || mediaEl.src || null) : null
        refreshDetectedMedia(candidateUrl)
    }, 1200)
    window.addEventListener("pagehide", () => {
        lastMediaSignature = ""
        MediaPopup.updatePopup([], null, false)
    })
    window.addEventListener("popstate", () => {
        lastMediaSignature = ""
        MediaPopup.updatePopup([], null, false)
    })
    document.addEventListener("mouseup", () => {
        showPopupDelayed(() => {
            const mousePositionInPage = mousePosition.getMousePositionInPage();
            if (!shouldCreatePopup() || mousePositionInPage === null) {
                return;
            }
            const selection = window.getSelection();
            if (selection == null) {
                return;
            }
            if (selection.type !== "Range") {
                return;
            }
            const linksFromSelection = getLinksFromSelection(selection);
            if (linksFromSelection.length == 0) {
                return
            }
            lastSelectionConsumed = false
            selectionPopup.showAddDownloadPopupUi(mousePositionInPage)
        })
    })
    browser.runtime.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== "object") {
            return
        }
        if (msg.type === "show_log") {
            console.log(...(msg.data ?? []))
            return
        }
        if (msg.type === "show_alert") {
            alert(createAlertStringForMyExtension(msg.data))
            return
        }
        if (msg.type === "ping_test") {
            return { reply: "pong" }
        }
        if (msg.type === "check_selected_text_for_links") {
            checkAndReportLinks()
            return
        }
        if (msg && msg.type === "downloadable_media_detected") {
            handleDetectedMedia(msg.data)
        }
    })
}).catch(e => {
    console.log("failed to load ab-dm-extension", e)
})
