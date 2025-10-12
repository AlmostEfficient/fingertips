## Gesture Delete Investigation Notes

### Goal
Allow the Thumb Down gesture to delete the current photo via CloudKit APIs so the UI never shows the slow confirmation modal.

### Attempts & Failures
1. **Service worker performs `records/lookup` with `fetch`.**
   - We reused the captured `/records/modify` endpoint to derive `/records/lookup`.
   - Calls failed with `421 Invalid or missing Origin` because the background context defaults to the `chrome-extension://` origin.

2. **Manual header override using `fetch` options.**
   - Added `Origin` and `Referer` headers to the `fetch` request.
   - Chrome stripped or ignored them, so CloudKit still saw the extension origin → same 421 response.

3. **Blocking `webRequest.onBeforeSendHeaders`.**
   - Tried to mutate outgoing headers before the request left the service worker.
   - Chrome refused to register the listener: `webRequestBlocking` is only allowed for enterprise-force-installed extensions, so the hook never fired.

4. **Declarative Net Request header rewrite.**
   - Installed a dynamic rule that sets `Origin`/`Referer` for every `ckdatabasews.icloud.com` request.
   - Verified the rule installs, but background-initiated `fetch` calls still return 421. The rewrite either does not apply to extension-origin requests or happens too late.

### Current Status
- Every API path from the background context still fails the origin check.
- UI fallback (click toolbar delete + modal confirm) is the only reliable option right now.
- Next steps need to move the metadata lookup into a page context (content script or injected script) so requests originate from `https://www.icloud.com`.
