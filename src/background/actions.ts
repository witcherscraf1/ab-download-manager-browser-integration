import {DownloadRequestHeaders, DownloadRequestItem} from "~/interfaces/DownloadRequestItem";
import * as backend from "~/backend/Backend";
import {ApiError, NetworkError} from "~/backend/ApiError";
import * as DialogUtils from "~/utils/DialogUtil";
import browser from "webextension-polyfill";
import {defaultDownloadRequestOptions, DownloadRequestOptions} from "~/interfaces/DownloadRequestOptions";
import {getLatestConfig} from "~/configs/Config";
import {run} from "~/utils/ScopeFunctions";

export async function addDownload(
    data: DownloadRequestItem[],
) {
    const config = getLatestConfig()
    const options: DownloadRequestOptions = {...defaultDownloadRequestOptions}
    if (config.silentAddDownload) {
        options.silentAdd = true
        options.silentStart = config.silentStartDownload
    }
    const response = !!await usingBackend(async () => {
        return await backend.addDownload(data, options)
    });
    if (response && config.silentAddDownload && data.length == 1) {
        run(() => {
            try {
                browser.notifications?.create({
                    type: "basic",
                    iconUrl: browser.runtime.getURL("icons/icon-128.png"),
                    title: browser.i18n.getMessage("abdm_notification_title"),
                    message: browser.i18n.getMessage("abdm_notification_download_captured_silently")
                })
            } catch (e) {
                console.log("can't send notifications")
            }
        })
    }
    return response
}

type HeaderLookupInput = string | {
    url: string,
    downloadPage?: string | null,
}

export async function getHeadersForUrls(inputs: HeaderLookupInput[]) {
    return Promise.all(inputs.map(async input => {
        if (typeof input === "string") {
            return await getHeadersForUrl(input)
        }
        return await getHeadersForUrl(input.url, input.downloadPage ?? null)
    }));
}

export async function getHeadersForUrl(
    url: string,
    downloadPage: string | null = null,
): Promise<DownloadRequestHeaders | null> {
    try {
        let headers: DownloadRequestHeaders = {}
        const cookie = (await browser.cookies.getAll({
            url: url,
        })).map((cookie) => {
            return `${cookie.name}=${cookie.value}`
        }).join("; ")
        headers["Cookie"] = cookie
        headers["Host"] = new URL(url).host
        headers["User-Agent"] = navigator.userAgent
        if (downloadPage) {
            headers["Referer"] = downloadPage
            try {
                headers["Origin"] = new URL(downloadPage).origin
            } catch (e) {
                // ignore malformed page URL
            }
        }
        return headers
    } catch (e) {
        console.log(e)
        return null
    }
}

async function usingBackend<T>(block: () => T) {
    try {
        return await block()
    } catch (e) {
        if (e instanceof ApiError) {
            DialogUtils.showAlertInCurrentTab(
                browser.i18n.getMessage("connection_error_api_error")
            )
        } else if (e instanceof NetworkError) {
            DialogUtils.showAlertInCurrentTab(
                browser.i18n.getMessage("connection_error_network_error")
            )
        } else {
            console.log("unknown error", e)
        }
    }
}

