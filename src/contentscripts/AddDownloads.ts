import {DownloadRequestHeaders, DownloadRequestItem} from "~/interfaces/DownloadRequestItem";
import browser from "webextension-polyfill";
import * as Configs from "~/configs/Config"

export async function addDownloads(downloadItems: Array<DownloadRequestItem>) {
    if (Configs.getLatestConfig().sendHeaders) {
        const headersOfLinks = await browser.runtime.sendMessage({
            type: "get_headers",
            data: downloadItems.map((item) => ({
                url: item.link,
                downloadPage: item.downloadPage,
            })),
        })
        downloadItems = downloadItems.map((value, index) => {
            const fetchedHeaders = headersOfLinks[index] ?? null
            return {
                ...value,
                // Merge captured request headers with page-derived fallback headers so
                // the downloader gets Referer/Origin/Cookie even when the intercepted
                // request did not include every header we care about.
                headers: fetchedHeaders ? {
                    ...fetchedHeaders,
                    ...(value.headers ?? {}),
                } : (value.headers ?? null),
            } as DownloadRequestItem
        })
    } else {
        downloadItems = downloadItems.map((value, index) => {
            return {
                ...value,
                headers: null, // remove headers if user don't want to send headers
            } as DownloadRequestItem
        })
    }
    await browser.runtime.sendMessage({type: "add_download", data: downloadItems})
}
