import isNetworkError from "is-network-error";
import {ApiError, NetworkError} from "~/backend/ApiError";
import {DownloadRequestItem} from "~/interfaces/DownloadRequestItem";
import {AddDownloadRequest} from "~/interfaces/AddDownloadRequest";

export function createBackendApi(
    port:number,
    basePath:string="",
){
    return new BackendApi(
        `http://localhost:${port}/${basePath}`
    )
}
export class BackendApi {
    constructor(private apiUrl: string) {
    }

    private async request(
        path: string,
        payload: any,
    ) {
        const timeout=2000
        const controller=new AbortController()
        const id=setTimeout(()=>controller.abort(),timeout)
        let response: Response
        try {
            if (path === "add") {
                try {
                    console.log("[BACKEND_API] add payload", summarizeAddPayload(payload))
                } catch (e) {
                    console.log("[BACKEND_API] add payload logging failed", e)
                }
            }
            response = await fetch(this.apiUrl + path, {
                method: "POST",
                body: JSON.stringify(payload),
                signal:controller.signal
            })
            clearTimeout(id)
            if (path === "add") {
                console.log("[BACKEND_API] add response", {
                    url: this.apiUrl + path,
                    status: response.status,
                    ok: response.ok,
                })
            }
        } catch (e) {
            if (path === "add") {
                console.log("[BACKEND_API] add request failed", {
                    url: this.apiUrl + path,
                    error: String(e),
                    aborted: controller.signal.aborted,
                })
            }
            if (isNetworkError(e) || controller.signal.aborted) {
                throw new NetworkError()
            } else {
                throw e
            }
        }
        if (!response.ok) {
            throw new ApiError(response)
        }
        return response
    }

    // TODO deprecated! remove this after a while!
    async addDownloadLegacy(items: DownloadRequestItem[]) {
        return this.request("add", items)
    }

    async addDownload(request: AddDownloadRequest) {
        return this.request("add", request)
    }

    async ping() {
        return this.request("ping", null)
    }
}

function summarizeAddPayload(payload: AddDownloadRequest | DownloadRequestItem[] | any) {
    const items = Array.isArray(payload) ? payload : (payload?.items ?? [])
    return {
        count: items.length,
        items: items.map((item: DownloadRequestItem) => ({
            link: item.link,
            type: item.type,
            suggestedName: item.suggestedName,
            downloadPage: item.downloadPage,
            headerKeys: Object.keys(item.headers ?? {}),
            headers: item.headers ?? null,
        })),
        options: Array.isArray(payload) ? null : (payload?.options ?? null),
    }
}
