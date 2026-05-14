import {DownloadableMedia} from "~/media/MediaOnTab"
import browser from "webextension-polyfill"
import * as Configs from "~/configs/Config"
import {isUrlBlacklisted} from "~/utils/UrlBlocker"

let popupEl: HTMLDivElement | null = null
let pinnedPopupEl: HTMLDivElement | null = null
let pinnedAnchorEl: HTMLElement | null = null
let pinnedObserver: IntersectionObserver | null = null
let pinnedScrollHandler: (() => void) | null = null
let pinnedPositionUpdater: (() => void) | null = null
let pinnedMode = false
let listVisible = false // start collapsed
let onItemClick: ((item: DownloadableMedia) => void) | undefined
let lastHoverTarget: HTMLElement | null = null
let hoverEnabled = true
let lastMouseX: number | null = null
let lastMouseY: number | null = null
let blindZoneRadius = 120 // pixels
let blindZoneRect: {left:number, top:number, right:number, bottom:number} | null = null
let hoverExpansion = 1.4 // expand target hit-area vertically by this factor (more tolerant)
const moveThreshold = 12 // minimum mouse move (px) to re-evaluate
const hoverGraceMs = 600 // wait before clearing hover target when mouse leaves
let hoverClearTimeout: number | null = null
// popup/overlay hide behavior
const hideAfterMouseLeaveMs = 2000 // ms to hide popup/overlay after leaving media
let popupHideTimer: number | null = null

function clearPopupHide() {
  if (popupHideTimer) { window.clearTimeout(popupHideTimer); popupHideTimer = null }
}

function schedulePopupHide(ms = hideAfterMouseLeaveMs) {
  if (pinnedMode) return
  clearPopupHide()
  popupHideTimer = window.setTimeout(() => {
    try { if (popupEl) { popupEl.remove(); popupEl = null } } catch (e) {}
    // also clear overlays unless keepPopupOpen
    // overlays removed: no-op
    popupHideTimer = null
  }, ms)
}

let keepPopupOpen = false // when user selects an item, keep popup visible

/* overlay-based small controls removed: using the main popup anchored to media instead */

/**
 * Create the main popup element
 */
function createPopup() {
    if (popupEl) return popupEl
    const downloadMediaTitle = browser.i18n.getMessage("download_media_title")
    const wrapper = document.createElement("div")
    wrapper.className = "abdm-extension"
    // mark extension UI so hover detector can ignore our elements
    wrapper.setAttribute('data-abdm-ignore', '1')
    wrapper.style.position = "fixed"
    wrapper.style.top = "-9999px"
    wrapper.style.left = "-9999px"
    wrapper.style.zIndex = "2147483647"
    wrapper.style.display = "flex"
    wrapper.style.flexDirection = "column"
    wrapper.style.alignItems = "start"
    wrapper.style.gap = "2px"
    wrapper.style.direction = "ltr"

    // Create style element using textContent to avoid CSP violation
    const styleEl = document.createElement("style")
    styleEl.textContent = `
      .abdm-extension * {
        font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
        box-sizing: border-box;
      }
      .abdm-media-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        border-radius: 10px;
        padding: 6px 8px;
        background: linear-gradient(to bottom right, #2E3038, #171820);
        border: rgba(255,255,255,0.16) solid 1px;
        box-shadow: rgba(0,0,0,0.08) 0px 2px 6px;
        cursor: pointer;
        color: #bdbdbd;
        font-size: 13px;
      }
      .abdm-media-header .title-wrapper,
      .abdm-media-header .abdm-media-close-btn {
        display: flex;
        align-items: center;
      }
      .abdm-media-header .appIcon {
        width: 20px;
        height: 20px;
        flex-shrink: 0;
      }
      .abdm-media-header .title-wrapper {
        gap: 4px;
        user-select: none; /* header text not selectable */
      }
      .abdm-media-header .abdm-media-close-btn {
        cursor: pointer;
        width: 20px;
        height: 20px;
        flex-shrink: 0;
        color: #aaa;
      }
      .abdm-media-header .abdm-media-close-btn:hover {
        color: #fff;
      }
      .abdm-media-list {
        background: linear-gradient(to bottom right, #2E3038, #171820);
        border: rgba(255,255,255,0.18) solid 1px;
        border-radius: 12px;
        overflow: auto;
        color: #d0d0d0;
        font-size: 12px;
        box-shadow: rgba(0,0,0,0.14) 0px 6px 14px;
        margin-top: 6px;
        display: none; /* start hidden */
        max-height: 40vh; /* slightly smaller */
      }
      .abdm-pinned .abdm-media-list,
      .abdm-extension[data-pinned-mode="1"] .abdm-media-list {
        position: absolute;
        left: 0;
        top: calc(100% + 6px);
        width: 100%;
        margin-top: 0;
      }
      .abdm-media-item {
        padding: 5px 8px;
        border-bottom: rgba(255,255,255,0.08) solid 1px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        align-items: start;
        min-width: 120px;
      }
      .abdm-media-item.selected {
        outline: 2px solid rgba(77,196,254,0.18);
        background: rgba(77,196,254,0.04);
      }
      .abdm-media-item:last-child {
        border-bottom: none;
      }
      .abdm-media-item:hover {
        background: rgba(255,255,255,0.08);
      }
      .abdm-item-title {
        font-weight: 500;
        color: #f7f7f7;
        font-size: 13px;
      }
      .abdm-item-details {
        font-size: 11px;
        opacity: 0.72;
      }
    `
    wrapper.appendChild(styleEl)

    // Create HTML content without inline style
    const contentHTML = `
    <div class="abdm-media-header">
      <div class="appIcon">
        <svg width="100%" height="100%" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M17.9267 0.594672C17.9267 0.266244 17.673 0 17.36 0H14.64C14.327 0 14.0733 0.266244 14.0733 0.594672V11.8934C14.0733 12.2219 13.8196 12.4881 13.5066 12.4881H12.5677C12.1068 12.4881 11.8386 13.0348 12.1066 13.4284L15.5389 18.471C15.7649 18.803 16.2351 18.803 16.4611 18.471L19.8934 13.4284C20.1614 13.0348 19.8932 12.4881 19.4323 12.4881H18.4934C18.1804 12.4881 17.9267 12.2219 17.9267 11.8934V0.594672ZM1.21792 22.1229C0.413852 20.1817 0 18.1011 0 16H4.80088C6.53592 16 7.88743 17.4585 8.5514 19.0615C8.95343 20.0321 9.54272 20.914 10.2856 21.6569C11.0285 22.3997 11.9104 22.989 12.881 23.391C13.8516 23.7931 14.8919 24 15.9424 24C16.993 24 18.0333 23.7931 19.0039 23.391C19.9745 22.989 20.8564 22.3997 21.5993 21.6569C22.3422 20.914 22.9315 20.0321 23.3335 19.0615C23.9975 17.4585 25.349 16 27.084 16H32C32 18.1011 31.5861 20.1817 30.7821 22.1229C29.978 24.0642 28.7994 25.828 27.3137 27.3137C25.828 28.7995 24.0642 29.978 22.1229 30.7821C20.1817 31.5862 18.1011 32 16 32C13.8989 32 11.8183 31.5862 9.87708 30.7821C7.93587 29.978 6.17202 28.7995 4.68629 27.3137C3.20057 25.828 2.022 24.0642 1.21792 22.1229ZM7.84788 3.4742C7.41753 3.82071 7.34399 4.45754 7.68363 4.89659C8.02327 5.33565 8.64748 5.41067 9.07783 5.06416L10.5389 3.88776C10.9692 3.54125 11.0428 2.90443 10.7031 2.46537C10.3635 2.02631 9.73928 1.95129 9.30893 2.2978L7.84788 3.4742ZM24.3121 3.4742C24.7425 3.82071 24.816 4.45754 24.4764 4.89659C24.1367 5.33565 23.5125 5.41067 23.0822 5.06416L21.6211 3.88776C21.1908 3.54125 21.1172 2.90443 21.4569 2.46537C21.7965 2.02631 22.4207 1.95129 22.8511 2.2978L24.3121 3.4742ZM3.02879 11.7691C2.51877 11.5639 2.26836 10.9758 2.46947 10.4555L3.15224 8.68897C3.35335 8.16864 3.92983 7.91316 4.43985 8.11834C4.94986 8.32352 5.20028 8.91166 4.99917 9.43199L4.3164 11.1985C4.11528 11.7188 3.5388 11.9743 3.02879 11.7691ZM29.6905 10.4555C29.8916 10.9758 29.6412 11.5639 29.1312 11.7691C28.6212 11.9743 28.0447 11.7188 27.8436 11.1985L27.1608 9.43199C26.9597 8.91166 27.2101 8.32352 27.7202 8.11834C28.2302 7.91316 28.8067 8.16864 29.0078 8.68897L29.6905 10.4555Z" fill="url(#paint0_linear_526_2322)"/>
                <path d="M27.3137 27.3138C24.3131 30.3144 20.2434 32.0001 16 32.0001C11.7565 32.0001 7.68686 30.3144 4.68628 27.3138V27.3138C6.3723 25.6278 9.09946 25.724 11.2807 26.6871C12.7534 27.3375 14.3589 27.6828 16 27.6828C17.6411 27.6828 19.2466 27.3375 20.7193 26.6871C22.9005 25.724 25.6277 25.6278 27.3137 27.3138V27.3138Z" fill="black" fill-opacity="0.25"/>
                <defs>
                    <linearGradient id="paint0_linear_526_2322" x1="33.3743" y1="15.3424" x2="-1.12085" y2="15.3424" gradientUnits="userSpaceOnUse">
                        <stop stop-color="#C631FF"/>
                        <stop offset="1" stop-color="#4DC4FE"/>
                    </linearGradient>
                </defs>
            </svg>
      </div>
      <div class="title-wrapper">
        <span>${downloadMediaTitle}</span>
        (<span class="count-text">0</span>)
      </div>
      <div class="abdm-media-close-btn">
        <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M5.29289 5.29289C5.68342 4.90237 6.31658 4.90237 6.70711 5.29289L12 10.5858L17.2929 5.29289C17.6834 4.90237 18.3166 4.90237 18.7071 5.29289C19.0976 5.68342 19.0976 6.31658 18.7071 6.70711L13.4142 12L18.7071 17.2929C19.0976 17.6834 19.0976 18.3166 18.7071 18.7071C18.3166 19.0976 17.6834 19.0976 17.2929 18.7071L12 13.4142L6.70711 18.7071C6.31658 19.0976 5.68342 19.0976 5.29289 18.7071C4.90237 18.3166 4.90237 17.6834 5.29289 17.2929L10.5858 12L5.29289 6.70711C4.90237 6.31658 4.90237 5.68342 5.29289 5.29289Z" fill="currentColor"/>
        </svg>
      </div>
    </div>
    <div class="abdm-media-list"></div>
    `
    
    const contentContainer = document.createElement("div")
    contentContainer.innerHTML = contentHTML
    while (contentContainer.firstChild) {
        wrapper.appendChild(contentContainer.firstChild)
    }

    const header = wrapper.querySelector<HTMLDivElement>(".abdm-media-header")!
    // subtle hover/click animations for the header (animated long control)
    header.style.transition = 'transform 160ms ease, box-shadow 120ms ease, background 120ms ease, color 120ms ease'
    header.addEventListener('mouseenter', () => {
      header.style.transform = 'translateY(-3px) scale(1.006)'
      header.style.background = 'linear-gradient(135deg,#C631FF,#4DC4FE)'
      header.style.boxShadow = '0 8px 26px rgba(0,0,0,0.38)'
      header.style.color = '#fff'
    })
    header.addEventListener('mouseleave', () => {
      header.style.transform = 'translateY(0) scale(1)'
      header.style.background = 'linear-gradient(to bottom right, #2E3038, #171820)'
      header.style.boxShadow = ''
      header.style.color = '#aaaaaa'
    })
    header.addEventListener('mousedown', () => {
      header.style.transform = 'translateY(-1px) scale(0.985)'
    })
    header.addEventListener('mouseup', () => {
      if (header.matches(':hover')) {
        header.style.transform = 'translateY(-3px) scale(1.006)'
      } else {
        header.style.transform = 'translateY(0) scale(1)'
      }
    })
    const listContainer = wrapper.querySelector<HTMLDivElement>(".abdm-media-list")!

    header.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("abdm-media-close-btn")) return
        listVisible = !listVisible
        listContainer.style.display = listVisible ? "block" : "none"
        pinnedPositionUpdater?.()
    })

    wrapper.querySelector<HTMLSpanElement>(".abdm-media-close-btn")!.onclick = () => {
      // remove current popup; allow future popups to re-create
      keepPopupOpen = false
      pinnedMode = false
      clearPopupHide()
      // overlays removed earlier; nothing to clear
      wrapper.remove()
      popupEl = null
    }

    document.body.appendChild(wrapper)
    // keep popup on top and manage hide on leave
    wrapper.addEventListener('mouseenter', () => { clearPopupHide() })
    wrapper.addEventListener('mouseleave', () => { if (!keepPopupOpen && !pinnedPopupEl) schedulePopupHide() })
    popupEl = wrapper
    return wrapper
}

function createPinnedPopup() {
  if (pinnedPopupEl) return pinnedPopupEl
  const base = createPopup()
  // clone but mark as pinned to separate hide/show logic
  const pinned = base.cloneNode(true) as HTMLDivElement
  pinned.classList.add('abdm-pinned')
  pinned.setAttribute('data-pinned-mode', '1')
  // smaller, compact style for pinned
  pinned.style.width = ''
  pinned.style.maxWidth = '320px'
  document.body.appendChild(pinned)
  // Pinned popup should NOT auto-hide on mouseleave
  pinned.addEventListener('mouseenter', () => { clearPopupHide() })
  pinnedPopupEl = pinned
  
  // Re-attach close button listener for the cloned element
  const closeBtn = pinned.querySelector<HTMLElement>(".abdm-media-close-btn")
  if (closeBtn) {
    closeBtn.onclick = () => {
      keepPopupOpen = false
      pinnedMode = false
      clearPopupHide()
      pinned.remove()
      pinnedPopupEl = null
      cleanupPinnedState()
    }
  }

  return pinned
}

function cleanupPinnedState() {
  if (pinnedObserver) {
    pinnedObserver.disconnect()
    pinnedObserver = null
  }
  if (pinnedScrollHandler) {
    window.removeEventListener("scroll", pinnedScrollHandler, true)
    window.removeEventListener("resize", pinnedScrollHandler)
    pinnedScrollHandler = null
  }
  pinnedPositionUpdater = null
  pinnedAnchorEl = null
  pinnedMode = false
}

function getAllMediaPlayers() {
  const includeImages = (() => {
    try { return Configs.getLatestConfig().registeredFileTypes.includes('img') } catch(e) { return false }
  })()
  const selector = includeImages ? "video, audio, img" : "video, audio"
  return Array.from(document.querySelectorAll<HTMLElement>(selector))
    .filter(el => (el instanceof HTMLVideoElement || el instanceof HTMLAudioElement || (includeImages && el instanceof HTMLImageElement)))
    .filter(el => el.offsetWidth > 24 && el.offsetHeight > 24 && el.isConnected)
}

function getBiggestMediaPlayer(onlyVisible = true) {
  const candidates = getAllMediaPlayers()
    .filter(el => {
      if (!onlyVisible) return true
      const r = el.getBoundingClientRect()
      return r.width > 24 && r.height > 24 && r.bottom >= 0 && r.top <= window.innerHeight && r.right >= 0 && r.left <= window.innerWidth
    })
  if (candidates.length === 0) return null
  candidates.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))
  return candidates[0] || null
}

function choosePinnedAnchor(items: DownloadableMedia[], preferred?: HTMLElement | null) {
  if (preferred?.isConnected) {
    return preferred
  }
  if (pinnedAnchorEl?.isConnected) {
    return pinnedAnchorEl
  }
  const mediaEls = getAllMediaPlayers()
  if (mediaEls.length === 0) {
    return null
  }
  const itemUris = new Set(items.map(item => item.uri.toLowerCase()))
  const exact = mediaEls.find((el) => {
    const src = (el instanceof HTMLImageElement) ? (el.currentSrc || el.src) : ((el as HTMLMediaElement).currentSrc || (el as HTMLMediaElement).src)
    return !!src && itemUris.has(src.toLowerCase())
  })
  if (exact) {
    return exact
  }
  const activeMedia = mediaEls.find((el) => el instanceof HTMLVideoElement && !el.paused && !el.ended)
  if (activeMedia) {
    return activeMedia
  }
  if (mediaEls.length === 1) {
    return mediaEls[0]
  }
  const biggestVisible = getBiggestMediaPlayer(true)
  if (biggestVisible) {
    return biggestVisible
  }
  return getBiggestMediaPlayer(false)
}

/**
 * Set the click listener for media items
 */
export function setItemClickListener(callback: (item: DownloadableMedia) => void) {
    onItemClick = callback
}

/**
 * Update the popup with a list of media items
 */
export function updatePopup(items: DownloadableMedia[], anchorEl?: HTMLElement | null, forcePinned = false) {

    if (pinnedMode && !forcePinned) {
      return
    }

    if (!items || items.length === 0) {
      if (pinnedMode && (popupEl || pinnedPopupEl)) {
        return
      }
      popupEl?.remove()
      popupEl = null
      cleanupPinnedState()
      pinnedPopupEl?.remove()
      pinnedPopupEl = null
      return
    }

    const popup = createPopup()
    if (forcePinned) {
      keepPopupOpen = true
      pinnedMode = true
      popup.setAttribute('data-pinned-mode', '1')
    } else {
      popup.removeAttribute('data-pinned-mode')
    }

    const countEl = popup.querySelector<HTMLSpanElement>(".count-text")!
    countEl.textContent = String(items.length)

    const listContainer = popup.querySelector<HTMLDivElement>(".abdm-media-list")!
    listContainer.innerHTML = ""

    for (const item of items) {
        const el = document.createElement("div")
        el.className = "abdm-media-item"

        const title = item.displayName ?? "Unnamed media"
        const details = [
            item.duration,
            item.size,
            item.resolution,
            item.bandwidth,
            item.extension,
        ].filter(Boolean).join(" · ")

        el.innerHTML = `
          <div class="abdm-item-title">${title}</div>
          <div class="abdm-item-details">${details}</div>
        `

        el.onclick = () => {
            onItemClick?.(item)
            // keep the popup visible after selection
            keepPopupOpen = true
            try {
              const prev = listContainer.querySelector<HTMLDivElement>('.abdm-media-item.selected')
              if (prev) prev.classList.remove('selected')
            } catch(e) {}
            el.classList.add('selected')
        }

        listContainer.appendChild(el)
    }

    // Position near provided anchor, nearest large media, or fallback top-left
    const anchor = forcePinned
      ? choosePinnedAnchor(items, anchorEl)
      : (anchorEl || getBiggestMediaPlayer(true) || getBiggestMediaPlayer(false))
    // Ensure popup is measurable: show it invisibly first
    popup.style.visibility = 'hidden'
    popup.style.display = 'flex'
    const popupW = popup.offsetWidth || 240
    const popupH = popup.offsetHeight || 120
    popup.style.visibility = 'visible'

    if (anchor) {
      const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b)
      const getPinnedPosition = (target: HTMLElement, elementWidth: number, anchorHeight: number) => {
        const rect = target.getBoundingClientRect()
        const desiredLeft = Math.round(rect.left)
        const desiredTop = Math.round(rect.top - anchorHeight)
        return {
          rect,
          left: clamp(desiredLeft, 0, Math.max(0, window.innerWidth - elementWidth)),
          top: clamp(desiredTop, 0, Math.max(0, window.innerHeight - anchorHeight)),
        }
      }

      if (forcePinned) {
        const positionMainPopup = () => {
          if (!popupEl) {
            return
          }
          if (!pinnedAnchorEl?.isConnected) {
            pinnedAnchorEl = choosePinnedAnchor(items, anchorEl)
          }
          if (!pinnedAnchorEl) {
            popupEl.style.position = 'fixed'
            popupEl.style.left = '0px'
            popupEl.style.top = '0px'
            popupEl.style.display = 'none'
            return
          }
          popupEl.style.position = 'fixed'
          popupEl.style.visibility = 'hidden'
          const headerHeight = popupEl.querySelector<HTMLElement>(".abdm-media-header")?.offsetHeight || 36
          const {rect, left, top} = getPinnedPosition(
              pinnedAnchorEl,
              popupEl.offsetWidth || popupW,
              headerHeight,
          )
          const visible = rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight
          popupEl.style.display = visible ? 'flex' : 'none'
          if (!visible) {
            popupEl.style.visibility = 'visible'
            return
          }
          popupEl.style.left = `${left}px`
          popupEl.style.top = `${top}px`
          popupEl.style.visibility = 'visible'
          const pr = popupEl.getBoundingClientRect()
          blindZoneRect = {
            left: pr.left - blindZoneRadius,
            top: pr.top - blindZoneRadius,
            right: pr.right + blindZoneRadius,
            bottom: pr.bottom + blindZoneRadius,
          }
        }
        cleanupPinnedState()
        pinnedMode = true
        pinnedAnchorEl = anchor
        pinnedPositionUpdater = positionMainPopup
        positionMainPopup()
        pinnedObserver = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (popupEl && e.target === pinnedAnchorEl) {
              positionMainPopup()
            }
          }
        }, { root: null, threshold: 0.1 })
        try {
          pinnedObserver.observe(pinnedAnchorEl)
        } catch (e) {
          // ignore if observe fails
        }
        pinnedScrollHandler = () => positionMainPopup()
        window.addEventListener("scroll", pinnedScrollHandler, true)
        window.addEventListener("resize", pinnedScrollHandler)
        return
      } else if (!anchorEl) {
        const pinned = createPinnedPopup()
        pinned.style.visibility = 'hidden'
        pinned.style.display = 'flex'
        const pw = pinned.offsetWidth || popupW
        const ph = pinned.offsetHeight || popupH
        pinned.style.visibility = 'visible'

        const positionPinnedPopup = () => {
          if (!pinnedPopupEl) {
            return
          }
          if (!pinnedAnchorEl?.isConnected) {
            pinnedAnchorEl = choosePinnedAnchor(items, null)
          }
          if (!pinnedAnchorEl) {
            pinnedPopupEl.style.left = `0px`
            pinnedPopupEl.style.top = `0px`
            pinnedPopupEl.style.display = 'none'
            return
          }
          pinnedPopupEl.style.visibility = 'hidden'
          const headerHeight = pinnedPopupEl.querySelector<HTMLElement>(".abdm-media-header")?.offsetHeight || 36
          const {rect, left, top} = getPinnedPosition(
              pinnedAnchorEl,
              pinnedPopupEl.offsetWidth || pw,
              headerHeight,
          )
          const visible = rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight
          pinnedPopupEl.style.display = visible ? 'flex' : 'none'
          if (!visible) {
            pinnedPopupEl.style.visibility = 'visible'
            return
          }
          pinnedPopupEl.style.left = `${left}px`
          pinnedPopupEl.style.top = `${top}px`
          pinnedPopupEl.style.visibility = 'visible'
          const pr = pinnedPopupEl.getBoundingClientRect()
          blindZoneRect = {
            left: pr.left - blindZoneRadius,
            top: pr.top - blindZoneRadius,
            right: pr.right + blindZoneRadius,
            bottom: pr.bottom + blindZoneRadius,
          }
        }

        pinned.style.position = 'fixed'
        cleanupPinnedState()
        pinnedAnchorEl = anchor
        pinnedPositionUpdater = positionPinnedPopup
        positionPinnedPopup()
        pinnedObserver = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (pinnedPopupEl && e.target === pinnedAnchorEl) {
              positionPinnedPopup()
            }
          }
        }, { root: null, threshold: 0.1 })
        try {
          pinnedObserver.observe(pinnedAnchorEl)
        } catch (e) {
          // ignore if observe fails
        }
        pinnedScrollHandler = () => positionPinnedPopup()
        window.addEventListener("scroll", pinnedScrollHandler, true)
        window.addEventListener("resize", pinnedScrollHandler)
        return
      } else {
        const {left, top} = getPinnedPosition(anchor, popupW, popupH)
        popup.style.top = `${top}px`
        popup.style.left = `${left}px`
        // update blind zone to avoid snapping back to elements overlapping the popup
        const pr = popup.getBoundingClientRect()
        blindZoneRect = {
          left: pr.left - blindZoneRadius,
          top: pr.top - blindZoneRadius,
          right: pr.right + blindZoneRadius,
          bottom: pr.bottom + blindZoneRadius,
        }
      }
    } else {
      cleanupPinnedState()
      // Fallback: no anchor element found, position at top-left of viewport
      popup.style.position = "fixed"
      popup.style.top = "8px"
      popup.style.left = "8px"
      // set blind zone around top-left fallback
      const pr = popup.getBoundingClientRect()
      blindZoneRect = {
        left: pr.left - blindZoneRadius,
        top: pr.top - blindZoneRadius,
        right: pr.right + blindZoneRadius,
        bottom: pr.bottom + blindZoneRadius,
      }
    }
}

  function findNearestLargeMedia(x: number, y: number, maxDistance = 250): HTMLElement | null {
    const includeImages = (() => {
        try { return Configs.getLatestConfig().registeredFileTypes.includes('img') } catch(e) { return false }
    })()
    const selector = includeImages ? "video, audio, img" : "video, audio"
    const els = Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter(e => e.offsetWidth > 24 && e.offsetHeight > 24)
    let best: {el: HTMLElement, dist: number} | null = null
    for (const el of els) {
      // ignore elements that are part of our extension UI
      if (popupEl && popupEl.contains(el)) continue
      if (el.closest && el.closest('.abdm-extension')) continue
      if (el.closest && el.closest('[data-abdm-ignore]')) continue
      // compute an expanded rect (vertically) to make it easier to keep the target
      const r = el.getBoundingClientRect()
      const expansion = Math.max(1, hoverExpansion)
      const extra = (r.height * (expansion - 1)) / 2
      const exTop = r.top - extra
      const exBottom = r.bottom + extra
      const exLeft = r.left
      const exRight = r.right

      // ignore elements inside blind zone (use expanded rect)
      if (blindZoneRect) {
        const intersects = !(exRight < blindZoneRect.left || exLeft > blindZoneRect.right || exBottom < blindZoneRect.top || exTop > blindZoneRect.bottom)
        if (intersects) continue
      }

      // use expanded rect center for distance calculation so vertical expansion helps
      const cx = (exLeft + exRight) / 2
      const cy = (exTop + exBottom) / 2
      const dx = cx - x
      const dy = cy - y
      const dist = Math.sqrt(dx*dx + dy*dy)
      if (dist <= maxDistance && (!best || dist < best.dist)) best = {el, dist}
    }
    return best ? best.el : null
  }

  function debounce(fn: (...args: any[]) => void, wait = 200) {
    let t: number | null = null
    return (...args: any[]) => {
      if (t) window.clearTimeout(t)
      // @ts-ignore
      t = window.setTimeout(() => fn(...args), wait)
    }
  }

  /**
   * Initialize hover-based detection: when mouse moves near a large media element
   * request media info from background and show popup anchored to that element.
   */
  export function initHoverDetector() {
    const onMove = debounce(async (ev: MouseEvent) => {
      const targetEl = ev.target as HTMLElement | null
      if (targetEl?.closest?.('.abdm-extension') || targetEl?.closest?.('[data-abdm-ignore]')) {
        return
      }
      if (!hoverEnabled) return
      if (pinnedMode) return
      // Skip blacklisted pages entirely — don't show synthetic fallback media
      if (isUrlBlacklisted(location.href)) return
      // small movement guard to avoid frequent re-evaluations
      if (lastMouseX !== null && lastMouseY !== null) {
        const dx = ev.clientX - lastMouseX
        const dy = ev.clientY - lastMouseY
        if (Math.sqrt(dx*dx + dy*dy) < moveThreshold) return
      }
      lastMouseX = ev.clientX
      lastMouseY = ev.clientY
      const x = ev.clientX
      const y = ev.clientY
      const target = findNearestLargeMedia(x, y)
      if (!target) {
        // Don't clear lastHoverTarget immediately; allow a short grace so small mouse
        // movements don't make the UI vanish. This avoids losing popup when cursor
        // briefly leaves the element.
        if (hoverClearTimeout) window.clearTimeout(hoverClearTimeout)
        hoverClearTimeout = window.setTimeout(() => {
          lastHoverTarget = null
          // Keep an existing popup visible instead of collapsing it the moment playback starts.
          if (!popupEl && !pinnedPopupEl) {
            schedulePopupHide()
          }
          hoverClearTimeout = null
        }, hoverGraceMs)
        return
      }
      if (hoverClearTimeout) { window.clearTimeout(hoverClearTimeout); hoverClearTimeout = null }
      // Clear any pending popup hide scheduled from a previous hover, since we have a new target.
      clearPopupHide();

      if (lastHoverTarget === target) return
      lastHoverTarget = target
      // try to extract candidate URLs from element
      let candidate: string | undefined
      if (target instanceof HTMLVideoElement || target instanceof HTMLAudioElement) {
        candidate = (target as HTMLMediaElement).currentSrc || (target as HTMLMediaElement).src
      } else if (target instanceof HTMLImageElement) {
        candidate = (target as HTMLImageElement).currentSrc || (target as HTMLImageElement).src
      }
      try {
        const msg = { type: 'hover_near_media', url: candidate }
        const resp = await browser.runtime.sendMessage(msg as any)
        if (resp && Array.isArray(resp.items) && resp.items.length > 0) {
          // show the main popup anchored to the media element
          try { updatePopup(resp.items as DownloadableMedia[], target) } catch (e) {}
          return
        }
      } catch (e) {
        // background may not handle this message; ignore and fallback
      }
      // Only synthesize a temporary candidate if we don't already have a real anchored popup.
      if (candidate && !popupEl && !pinnedPopupEl && !pinnedMode) {
        const extMatch = candidate.match(/\.([a-z0-9]{2,6})(?:\?|$)/i)
        const extension = extMatch ? extMatch[1] : undefined
        const synthetic: DownloadableMedia = {
          uri: candidate,
          displayName: candidate.split('/').pop() || candidate,
          extension,
          type: 'unknown',
        } as any
        try { updatePopup([synthetic], target) } catch (e) {}
      }
    }, 180)

    document.addEventListener('mousemove', onMove)
  }

  export function disableHover() { hoverEnabled = false }
  export function enableHover() { hoverEnabled = true }

  // no overlay positioning necessary after removing small overlay controls

/**
 * Toggle the visibility of the list manually
 */
export function toggleList(
    visible?: boolean,
) {
    if (!popupEl) return
    const listContainer = popupEl.querySelector<HTMLDivElement>(".abdm-media-list");
    if (!listContainer) return
    switch (visible) {
        case undefined:
            listVisible = !listVisible
            break
        default:
            listVisible = visible
    }
    listContainer.style.display = listVisible ? "block" : "none"
    pinnedPositionUpdater?.()
}
