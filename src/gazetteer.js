/**
 * Shard registry: loads the country index once, then one country's places at a time.
 *
 * Loading is done with a script tag rather than fetch() quite deliberately. This app is meant
 * to be opened by double-clicking the HTML file, and on a file:// URL every modern browser
 * blocks fetch and XMLHttpRequest against a sibling file as a cross-origin read. A classic
 * script tag is not subject to that check, so the shards are written as calls to GAZ() and
 * simply execute. The cost is that a load failure is reported as "did not call back" rather
 * than as an HTTP status, which the error below accounts for.
 */

import { fold } from "./fold.js";

let index = null;
const shards = new Map();
const inFlight = new Map();
let base = "data/";

/** Where the shards live, relative to the HTML file. */
export function setDataPath(path) {
    base = path;
}

export function getIndex() {
    return index;
}

export function shardLoaded(cc) {
    return shards.has(cc);
}

export function getShard(cc) {
    return shards.get(cc) || null;
}

function cumulative(deltas) {
    const out = new Array(deltas.length);
    let running = 0;
    for (let i = 0; i < deltas.length; i++) {
        running += deltas[i];
        out[i] = running;
    }
    return out;
}

/**
 * Rebuilds the name index from its front-coded form.
 *
 * Every key keeps EVERY row that folds to it. Four US places fold to "stlouis"; letting the
 * first win is the silent-wrongness this tool exists to prevent, so the list is kept whole and
 * the resolver is made to justify picking one.
 */
function decodeKeys(payload) {
    const suffixes = payload.ks.split("\n");
    const byName = new Map();
    let previous = "";
    for (let i = 0; i < suffixes.length; i++) {
        const shared = payload.kp.charCodeAt(i) - 48;
        const key = previous.slice(0, shared) + suffixes[i];
        previous = key;
        const bucket = byName.get(key);
        if (bucket) {
            bucket.push(payload.ki[i]);
        } else {
            byName.set(key, [payload.ki[i]]);
        }
    }
    return byName;
}

// The shard and index files call these. Defined on window so a plain script tag reaches them.
window.GAZIDX = function (raw) {
    const a1ByCode = new Map();
    const a1ByName = new Map();
    for (let i = 0; i < raw.a1c.length; i++) {
        a1ByCode.set(raw.a1c[i], i);
        if (raw.a1n[i]) {
            // Namespaced by country so Georgia the US state and Georgia the country, or the
            // several provinces called "Central", cannot collide.
            a1ByName.set(raw.a1c[i].slice(0, 2) + "|" + fold(raw.a1n[i]), i);
        }
    }
    index = raw;
    index.a1ByCode = a1ByCode;
    index.a1ByName = a1ByName;
    index.ccIndex = new Map(raw.ccc.map((cc, i) => [cc, i]));
};

window.GAZ = function (cc, payload) {
    shards.set(cc, {
        lon: cumulative(payload.lon),
        lat: cumulative(payload.lat),
        a1: payload.a1,
        a2: payload.a2,
        fc: payload.fc,
        pop: payload.pop,
        names: payload.n.split("\n"),
        byName: decodeKeys(payload),
    });
};

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = url;
        el.onload = () => resolve();
        el.onerror = () => reject(new Error("Could not load " + url));
        document.head.appendChild(el);
    });
}

function once(key, url, check) {
    if (check()) {
        return Promise.resolve();
    }
    let promise = inFlight.get(key);
    if (!promise) {
        promise = loadScript(url).then(() => {
            if (!check()) {
                // A script tag reports network failure but not a file that loaded and did
                // nothing, so say what the user can actually check.
                throw new Error("Loaded " + url + " but it did not register any data. Is the data folder next to this file, and complete?");
            }
        }).finally(() => inFlight.delete(key));
        inFlight.set(key, promise);
    }
    return promise;
}

export function loadIndex() {
    return once("index", base + "index.js", () => index !== null);
}

export function loadShard(cc) {
    return once(cc, base + cc + ".js", () => shards.has(cc));
}
