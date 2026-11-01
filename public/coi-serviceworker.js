/*
 * Vendored from coi-serviceworker v0.1.7 (MIT, https://github.com/gzuidhof/coi-serviceworker), modified for MV Studio:
 * COEP "credentialless" is hard-coded. Upstream learns the policy from a postMessage sent after the page loads, so the
 * navigation that first makes the page isolated gets "require-corp" and no-cors images from hosts without a CORP header
 * fail to load. The pilot measured both behaviours (see THIRD_PARTY_NOTICES.md).
 * Also reloads on "controllerchange": upstream's "updatefound" listener is attached after register() resolves and can
 * miss the event, which left about 1 in 10 first visits without isolation.
 * Lets cross-origin requests in CORS mode go straight to the network (see the fetch handler).
 * Does not reload on "updatefound": it fires while the worker is still installing, so the reloaded document loads
 * without it. If the worker then claims that document before this script has run (it waits for this file), the
 * "controllerchange" is missed and upstream's "active but not controlling" check sees a controller, leaving the page
 * controlled but not isolated. Instead the page reloads whenever an active worker exists and the page is not
 * isolated, once per document and at most three times in a row, so a browser that cannot isolate never loops.
 */
/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
/*
 * MIT License
 *
 * Copyright (c) 2021 Guido Zuidhof
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// Hard-coded: the page cannot tell the SW its policy before the navigation request is served.
let coepCredentialless = true;
if (typeof window === 'undefined') {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener("message", (ev) => {
        if (!ev.data) {
            return;
        } else if (ev.data.type === "deregister") {
            self.registration
                .unregister()
                .then(() => {
                    return self.clients.matchAll();
                })
                .then(clients => {
                    clients.forEach((client) => client.navigate(client.url));
                });
        }
    });

    self.addEventListener("fetch", function (event) {
        const r = event.request;
        if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
            return;
        }
        // Requests to other sites in CORS mode go straight to the network: CORS already lets the isolated page read
        // them, so they need no headers from here. Chrome also gives a service worker about 5 minutes to answer one
        // request, which cut off local AI models that take longer to send their answer.
        if (r.mode === "cors" && new URL(r.url).origin !== self.location.origin) {
            return;
        }

        const request = (coepCredentialless && r.mode === "no-cors")
            ? new Request(r, {
                credentials: "omit",
            })
            : r;
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.status === 0) {
                        return response;
                    }

                    const newHeaders = new Headers(response.headers);
                    newHeaders.set("Cross-Origin-Embedder-Policy",
                        coepCredentialless ? "credentialless" : "require-corp"
                    );
                    if (!coepCredentialless) {
                        newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
                    }
                    newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

                    return new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: newHeaders,
                    });
                })
                .catch((e) => console.error(e))
        );
    });

} else {
    (() => {
        // You can customize the behavior of this script through a global `coi` variable.
        const coi = {
            shouldRegister: () => true,
            shouldDeregister: () => false,
            coepCredentialless: () => true,
            doReload: () => window.location.reload(),
            quiet: false,
            ...window.coi
        };

        const n = navigator;

        if (n.serviceWorker && n.serviceWorker.controller) {
            n.serviceWorker.controller.postMessage({
                type: "coepCredentialless",
                value: coi.coepCredentialless(),
            });

            if (coi.shouldDeregister()) {
                n.serviceWorker.controller.postMessage({ type: "deregister" });
            }
        }

        const RELOADS_KEY = "coiReloads";
        const storage = (fn) => {
            try {
                return fn(window.sessionStorage);
            } catch (e) {
                return null;
            }
        };

        // If we're already coi: do nothing. Perhaps it's due to this script doing its job, or COOP/COEP are
        // already set from the origin server. Also if the browser has no notion of crossOriginIsolated, just give up here.
        if (window.crossOriginIsolated !== false || !coi.shouldRegister()) {
            storage((s) => s.removeItem(RELOADS_KEY));
            return;
        }

        let reloading = false;
        const reload = (reason) => {
            if (reloading) return;
            const count = Number(storage((s) => s.getItem(RELOADS_KEY))) || 0;
            if (count >= 3) {
                !coi.quiet && console.warn("COOP/COEP Service Worker active but the page is still not cross-origin isolated; not reloading again.");
                return;
            }
            storage((s) => s.setItem(RELOADS_KEY, String(count + 1)));
            reloading = true;
            !coi.quiet && console.log(`Reloading page to make use of COOP/COEP Service Worker (${reason}).`);
            coi.doReload();
        };

        if (!window.isSecureContext) {
            !coi.quiet && console.log("COOP/COEP Service Worker not registered, a secure context is required.");
            return;
        }

        // In some environments (e.g. Chrome incognito mode) this won't be available
        if (n.serviceWorker) {
            n.serviceWorker.addEventListener("controllerchange", () => reload("controllerchange"));
            n.serviceWorker.register(window.document.currentScript.src).then(
                (registration) => {
                    !coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);

                    // An active worker serves the next load with the headers, whether or not it already controls this
                    // document (it may have claimed it after its response arrived). A worker still installing claims
                    // the page when it activates, which reloads it through "controllerchange".
                    if (registration.active) {
                        reload(n.serviceWorker.controller ? "controlled without isolation" : "not controlling");
                    }
                },
                (err) => {
                    !coi.quiet && console.error("COOP/COEP Service Worker failed to register:", err);
                }
            );
        }
    })();
}
