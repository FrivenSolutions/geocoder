#!/usr/bin/env node
/**
 * Reduces a full GeoNames allCountries export into dist/data/ - one shard per country, plus a
 * small always-loaded index.
 *
 *   node scripts/build-gazetteer.mjs <dir containing the GeoNames files>
 *
 * Needs allCountries.txt, admin1CodesASCII.txt, admin2Codes.txt and countryInfo.txt from
 * https://download.geonames.org/export/dump/ - CC BY 4.0, attribution in dist/ATTRIBUTION.txt.
 * Run by hand when refreshing the data; the app build does not touch it.
 *
 * The encoding is the Power BI Flow Map's, which was measured rather than guessed:
 *
 *   rows sorted by longitude and delta-encoded
 *   name index front-coded against the previous key
 *   names newline-joined rather than a JSON array
 *
 * Two things differ from the Flow Map, both forced by scale. That visual bundles
 * cities15000 - 26,000 places, one 1.7 MB blob loaded whether the report needs it or not.
 * This tool carries every populated place GeoNames knows plus the military and transport
 * slice, which is 200x the rows, so:
 *
 *   - Coordinates are kept to 4dp (~11 m) rather than 2dp (~1.1 km). A flow map draws an
 *     arrow between two dots and 2dp is invisible; here the coordinate IS the output, and
 *     handing back a value known to be a kilometre off would be indefensible.
 *   - The data is split per country and loaded on demand. A US-only spreadsheet pulls the US
 *     shard and nothing else.
 *
 * The name index deliberately keeps EVERY row that folds to a given key rather than letting
 * the first win. Silently choosing one is the failure this tool exists to avoid: the resolver
 * narrows by subdivision and by tier, and reports an ambiguity it cannot narrow.
 */

import { createReadStream, readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { feature } from "topojson-client";
import { geoCentroid, geoArea } from "d3-geo";
import { fold, isLatin, tokens } from "../src/fold.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = process.argv[2];
if (!src) {
    console.error("usage: node scripts/build-gazetteer.mjs <geonames-dir>");
    process.exit(1);
}
const out = join(root, "dist", "data");
const work = join(root, ".tmp", "split");

/** Coordinates are stored as integers at this scale. 1e4 is ~11 m. */
const SCALE = 10000;

/**
 * The non-populated features worth carrying.
 *
 * The Flow Map's coverage note diagnosed this precisely: Hanscom AFB is absent from every
 * cities* tier not because the threshold is too high but because it is feature class S.AIRP,
 * and the cities* files contain only class P. Military and transport sites are a different
 * slice of the data, not a deeper one - so no population tier could ever reach them.
 *
 * This is that slice: what armed forces occupy, and what goods move through.
 */
const FACILITY = new Set([
    // military
    "L.MILB", "L.NVB", "S.INSM", "S.BRKS", "S.AIRB", "L.MVA", "L.RNGA",
    "S.FT", "S.STNC", "S.MFGM", "S.SCHM", "A.LTER", "A.ZNB",
    // air
    "S.AIRP", "S.AIRF", "S.AIRH", "S.AIRQ", "S.AIRT", "H.AIRS",
    // sea
    "L.PRT", "H.HBR", "S.DCKY", "S.WHRF", "S.LDNG", "S.FY", "S.FYT", "S.BTYD", "S.TRMO",
    // land
    "S.RSTN", "S.RSTP", "S.BUSTN", "S.BUSTP", "S.TRANT",
    // border
    "S.PSTB", "S.PSTC", "S.CSTM",
    // industry and commerce
    "S.MFG", "S.MFGQ", "S.BLDO", "S.DPOF", "S.OILR", "S.ADMF", "S.CTRF",
    // named buildings of every other kind
    "S.BLDG",
]);

/**
 * Administrative areas: civil divisions rather than settlements.
 *
 * This is where townships live. GeoNames files a US township as A.ADM3 named "Township of
 * Parker", not as a populated place - 29,387 of them - so no amount of depth in class P could
 * ever reach one. Counties and UK-style shires are the same story at ADM2.
 *
 * They are areas, not points, so they rank below everything that has a real position and are
 * always reported as approximate.
 */
const ADMIN = new Set([
    "A.ADM1", "A.ADM2", "A.ADM3", "A.ADM4", "A.ADM5", "A.ADMD", "A.ADMS",
    "A.PRSH", "A.TERR", "A.ZN",
    "A.ADM1H", "A.ADM2H", "A.ADM3H", "A.ADM4H", "A.ADM5H", "A.ADMDH",
]);

/** Everything carried that is not a populated place. */
const EXTRA = new Set([...FACILITY, ...ADMIN]);

/**
 * Populated places that exist, but should never win a tie against a real town.
 *
 * PPLX is a section of a city, PPLL a locality, and the last three are places that no longer
 * exist. Carrying them costs 1% of the rows and means a historical address still resolves;
 * ranking them below everything else means "Springfield" never resolves to a demolished
 * hamlet because it happened to sort first.
 */
const MINOR = new Set(["PPLX", "PPLL", "PPLQ", "PPLW", "PPLH", "PPLCH"]);

/**
 * What must not contribute to a derived subdivision or county centre.
 *
 * Those centres answer "roughly where in this area are things", so they are averaged over
 * settlements. An administrative division is the area itself - averaging a county's own record
 * into the county's centre is circular - and a named building is too fine-grained to move the
 * answer in any meaningful direction. Bare codes, since every GeoNames code is unique across
 * classes and pass 1 stores the code alone.
 */
const BARE_ADMIN = new Set([...ADMIN].map((code) => code.slice(2)));
const NOT_A_SETTLEMENT = new Set([...MINOR, "BLDG", ...BARE_ADMIN]);

const lines = (name) => readFileSync(join(src, name), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));

/**
 * Values of the alternateNames language column that are not languages.
 *
 * The file reuses that column for Wikipedia links, Wikidata ids, postcodes and phone
 * prefixes. "link" and "wkdt" alone are a quarter of a million rows in the first three
 * million, and none of them is a name anybody types.
 */
const NOT_A_LANGUAGE = new Set(["link", "wkdt", "post", "unlc", "phone", "tcid", "fr_1793"]);

/** Codes that are identifiers rather than translations, worth keeping only for facilities. */
const CODE_LANGUAGE = new Set(["abbr", "iata", "icao", "faac"]);

/**
 * Chooses which alternate names are worth indexing.
 *
 * The alternatenames column is long and unranked - Tel Aviv carries 90 - so taking the first
 * few takes junk. For Tel Aviv the first four Latin entries are "Lungsod ng Tel Aviv-Yafo",
 * "TLV", "Tehl'-Aviu" and "Tel Avevs", while the form an English speaker will actually type,
 * "Tel Aviv-Yafo", sits at position 10. A bigger cap would have caught it, at the cost of
 * indexing every transliteration in every alphabet for five million places.
 *
 * So the rule is about *kind* rather than position: for a town, keep an alternate only where
 * its words are a subset or a superset of the primary name's. "Tel Aviv-Yafo" is a superset of
 * "Tel Aviv" and stays; "Tel Awiw" and "Telavivum" are neither and go. This is deliberately
 * stricter than a substring test, which would happily key "Elyria" onto Ely.
 *
 * Facilities get looser treatment, because that is where the abbreviations live and there are
 * only 162,000 of them. A base is written half a dozen ways and the short code - KBED, TLV,
 * RMS - is one of them.
 */
/** A base, airport or port rather than a town or a civil division. */
function facilityCode(fcode) {
    return fcode.slice(0, 3) !== "PPL" && !BARE_ADMIN.has(fcode);
}

function pickAlternates(name, ascii, alt, fcode) {
    if (!alt) {
        return [];
    }
    // Only real facilities get the loose treatment. A base or airport is written half a dozen
    // ways and its short code - KBED, TLV - is one of them; a county has no such identifier,
    // so the looser rule would only let noise in.
    const facility = facilityCode(fcode);
    const primary = new Set(tokens(name).concat(tokens(ascii)));
    const usable = alt.split(",").filter((one) => one.length <= 60 && isLatin(one) && tokens(one).length);
    const out = [];
    const seen = new Set();
    const cap = facility ? 8 : 7;
    const push = (one) => {
        if (!seen.has(one) && out.length < cap) {
            seen.add(one);
            out.push(one);
        }
    };
    const isVariant = (one) => {
        const word = tokens(one);
        return word.every((w) => primary.has(w)) || [...primary].every((w) => word.includes(w));
    };

    // Spelling variants first: "Tel Aviv-Yafo" for "Tel Aviv". These share words with the
    // primary name, and they are what the word-subset test was introduced to catch.
    for (const one of usable) {
        if (isVariant(one) || (facility && one.length <= 5)) {
            push(one);
        }
    }

    /**
     * Then the first few alternates whatever they are, because the most important ones share
     * no words with the primary name at all.
     *
     * The subset test alone discarded every endonym and exonym: Prague is stored as "Prague"
     * with "Praha" among its alternates, and "praha" is not a variant of "prague" by any
     * string test. The effect was not merely that "Praha, CZE" missed - with the real city
     * unindexed under its own local name, a hamlet won the lookup instead, so "Torino" landed
     * in Ferrara and "Moskva" in Tver Oblast. Wrong answers, confidently given.
     *
     * Position is a decent proxy here: GeoNames lists the local and major-language forms
     * early, and the long tail of transliterations later. Four is enough for Praha, Roma,
     * Napoli, Munchen and Cologne without reopening the door to sixty spellings of Tel Aviv.
     */
    let extra = 0;
    for (const one of usable) {
        if (extra >= 4) {
            break;
        }
        push(one);
        extra++;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Countries. GeoNames stores alpha-2; alpha-3 is the documented input form.
// ---------------------------------------------------------------------------
const iso3to2 = new Map();
const nameTo2 = new Map();
const displayName = new Map();
const numericTo2 = new Map();
for (const r of lines("countryInfo.txt").map((l) => l.split("\t"))) {
    const [a2, a3, numeric, , name] = r;
    if (!a2 || a2.length !== 2) {
        continue;
    }
    if (a3 && a3.length === 3) {
        iso3to2.set(a3.toUpperCase(), a2.toUpperCase());
    }
    if (numeric) {
        numericTo2.set(String(Number(numeric)), a2.toUpperCase());
    }
    if (name) {
        nameTo2.set(fold(name), a2.toUpperCase());
        displayName.set(a2.toUpperCase(), name);
    }
}

/**
 * The languages each country's own names are written in, from countryInfo's Languages
 * column, reduced to primary subtags: "en-US,es-US,haw,fr" becomes en, es, haw, fr.
 *
 * This is what decides whether an alternate name is worth keeping. A place in Italy should
 * carry its Italian name and its English one; its Armenian and Bengali names are weight.
 */
const countryLanguages = new Map();
for (const r of lines("countryInfo.txt").map((l) => l.split("\t"))) {
    const a2 = r[0];
    if (!a2 || a2.length !== 2) {
        continue;
    }
    const langs = new Set(["en"]);
    for (const tag of (r[15] || "").split(",")) {
        const primary = tag.trim().split("-")[0].toLowerCase();
        if (primary) {
            langs.add(primary);
        }
    }
    countryLanguages.set(a2.toUpperCase(), langs);
}

// GeoNames' own country names are not always what a user types: NL is "The Netherlands".
for (const [folded, a2] of [...nameTo2]) {
    if (folded.startsWith("the") && folded.length > 5 && !nameTo2.has(folded.slice(3))) {
        nameTo2.set(folded.slice(3), a2);
    }
}

/**
 * The fifteen ISO 3166-1 short names that use the inverted form.
 *
 * "Korea, Republic of" is exactly what someone pasting "the standard country name" produces,
 * and its folded shape is not what GeoNames stores. Korea and Taiwan in particular are common
 * origins in the kind of export this tool reads.
 */
for (const [alias, a2] of Object.entries({
    korearepublicof: "KR", koreademocraticpeoplesrepublicof: "KP",
    taiwanprovinceofchina: "TW", iranislamicrepublicof: "IR", moldovarepublicof: "MD",
    tanzaniaunitedrepublicof: "TZ", venezuelabolivarianrepublicof: "VE",
    boliviaplurinationalstateof: "BO", micronesiafederatedstatesof: "FM",
    palestinestateof: "PS", congodemocraticrepublicofthe: "CD",
    virginislandsus: "VI", virginislandsbritish: "VG",
    macedoniatheformeryugoslavrepublicof: "MK", syrianarabrepublic: "SY",
})) {
    nameTo2.set(alias, a2);
}
for (const [alias, a2] of Object.entries({
    usa: "US", unitedstatesofamerica: "US", america: "US", unitedstates: "US", us: "US",
    uk: "GB", greatbritain: "GB", britain: "GB", england: "GB", scotland: "GB", wales: "GB",
    northernireland: "GB", holland: "NL", netherlands: "NL", deutschland: "DE",
    southkorea: "KR", northkorea: "KP", uae: "AE", ivorycoast: "CI", burma: "MM",
    czechia: "CZ", czechrepublic: "CZ", vatican: "VA", russia: "RU", vietnam: "VN",
    macedonia: "MK", swaziland: "SZ", capeverde: "CV", eastimor: "TL", turkey: "TR",
})) {
    nameTo2.set(alias, a2);
}
// GeoNames alpha-3 values that are not ISO 3166-1.
for (const [a3, a2] of Object.entries({ KOS: "XK", PSX: "PS", SOL: "SO", CYN: "CY", SAH: "EH" })) {
    iso3to2.set(a3, a2);
}

// ---------------------------------------------------------------------------
// Subdivisions and counties.
// ---------------------------------------------------------------------------
const a1Name = new Map();
for (const r of lines("admin1CodesASCII.txt").map((l) => l.split("\t"))) {
    if (r[0] && r[1]) {
        a1Name.set(r[0], r[1]);
    }
}
const a2Name = new Map();
for (const r of lines("admin2Codes.txt").map((l) => l.split("\t"))) {
    if (r[0] && r[1]) {
        a2Name.set(r[0], r[1]);
    }
}

/**
 * GeoNames' admin1 codes are only ISO-like for a few countries. The US uses postal codes
 * (US.CO) and Great Britain uses GB.ENG, but Canada is CA.01, Australia AU.08, Israel IL.05 -
 * FIPS-style numerics nobody would type. So "London|ON|CAN" cannot match by code.
 *
 * Declared by subdivision NAME and resolved below to whatever code GeoNames happens to use, so
 * the mapping survives a renumbering. Countries not listed still accept the subdivision's name.
 */
const A1_ALIASES = {
    CA: {
        AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
        NL: "Newfoundland and Labrador", NS: "Nova Scotia", NT: "Northwest Territories",
        NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec",
        SK: "Saskatchewan", YT: "Yukon",
    },
    AU: {
        NSW: "New South Wales", VIC: "Victoria", QLD: "Queensland",
        WA: "Western Australia", SA: "South Australia", TAS: "Tasmania",
        NT: "Northern Territory", ACT: "Australian Capital Territory",
    },
    IL: { TA: "Tel Aviv", JM: "Jerusalem", HA: "Haifa", Z: "Northern District", D: "Southern District" },
    NL: {
        ZH: "South Holland", NH: "North Holland", UT: "Utrecht", GE: "Gelderland",
        NB: "North Brabant", LI: "Limburg", OV: "Overijssel", FR: "Friesland",
        GR: "Groningen", DR: "Drenthe", FL: "Flevoland", ZE: "Zeeland",
    },
    MX: {
        AGU: "Aguascalientes", BCN: "Baja California", BCS: "Baja California Sur",
        CAM: "Campeche", CHP: "Chiapas", CHH: "Chihuahua", COA: "Coahuila", COL: "Colima",
        CMX: "Mexico City", DIF: "Mexico City", DUR: "Durango", GUA: "Guanajuato",
        GRO: "Guerrero", HID: "Hidalgo", JAL: "Jalisco", MEX: "Mexico", MIC: "Michoacan",
        MOR: "Morelos", NAY: "Nayarit", NLE: "Nuevo Leon", OAX: "Oaxaca", PUE: "Puebla",
        QUE: "Queretaro", ROO: "Quintana Roo", SLP: "San Luis Potosi", SIN: "Sinaloa",
        SON: "Sonora", TAB: "Tabasco", TAM: "Tamaulipas", TLA: "Tlaxcala",
        VER: "Veracruz", YUC: "Yucatan", ZAC: "Zacatecas",
    },
};

// ---------------------------------------------------------------------------
// Pass 1 - split the dump into per-country files, keeping only the columns needed.
//
// 13.5M rows and 1.8 GB do not fit in memory as objects, and the dump is ordered by
// geonameid rather than by country, so a second read per country is not an option either.
// Splitting first turns one intractable job into 250 small ones.
// ---------------------------------------------------------------------------
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const FLUSH = 20000;
const buffers = new Map();
const flush = (cc) => {
    const buf = buffers.get(cc);
    if (buf && buf.length) {
        appendFileSync(join(work, cc + ".tsv"), buf.join("\n") + "\n");
        buf.length = 0;
    }
};

let read = 0;
let kept = 0;
const keptIds = [];
const keptCc = [];
process.stdout.write("pass 1  splitting by country ");
const rl = createInterface({ input: createReadStream(join(src, "allCountries.txt")), crlfDelay: Infinity });
for await (const line of rl) {
    read++;
    if (read % 1000000 === 0) {
        process.stdout.write(".");
    }
    const c = line.split("\t");
    const cls = c[6];
    /**
     * Matched on class AND code together, rather than filtering to a set of classes and then
     * checking codes against a bare list.
     *
     * The earlier version kept classes S and L and tested the code against a list that also
     * held HBR, AIRS and LTER - which are classes H, H and A. Those three never matched
     * anything, silently, and 6,220 harbours were missing from a gazetteer whose own source
     * listed them as wanted. A code paired with its class cannot rot that way: a wrong pair
     * matches nothing and shows up as a zero in the build summary.
     */
    const keep = cls === "P" || EXTRA.has(cls + "." + c[7]);
    if (!keep) {
        continue;
    }
    const cc = c[8];
    if (!cc || cc.length !== 2 || !c[1]) {
        continue;
    }
    const lat = Number(c[4]);
    const lon = Number(c[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        continue;
    }
    kept++;
    // Remembered so the alternate-names pass can tell, for 19 million rows, which of them
    // belong to a place this gazetteer carries and which country that place is in.
    keptIds.push(Number(c[0]));
    keptCc.push(cc);
    let buf = buffers.get(cc);
    if (!buf) {
        buf = [];
        buffers.set(cc, buf);
    }
    // geonameid, name, asciiname, alternates, lat, lon, fcode, admin1, admin2, population
    buf.push([c[0], c[1], c[2], c[3], c[4], c[5], c[7], c[10] || "", c[11] || "", c[14] || "0"].join("\t"));
    if (buf.length >= FLUSH) {
        flush(cc);
    }
}
for (const cc of buffers.keys()) {
    flush(cc);
}
console.log("\n        " + read.toLocaleString() + " rows read, " + kept.toLocaleString() + " kept, " + buffers.size + " countries");

// ---------------------------------------------------------------------------
// Pass 2 - the names each place is actually known by.
//
// The alternatenames column embedded in allCountries is unusable for choosing: it is sorted
// alphabetically and carries no language, so Rome lists "An Roimh" first and "Roma"
// fifteenth, and any "keep the first few" rule picks languages at random. Taking the subset
// that shares words with the primary name instead discards every endonym, which is worse -
// with Rome unindexed as "Roma", a hamlet wins the lookup and answers confidently.
//
// alternateNamesV2 is the same data with an ISO language code, a preferred-name flag and a
// historic flag per row. That turns the choice from a guess into a filter: keep each place's
// name in its own country's languages and in English, drop the other ninety.
//
// 19.25 million rows against 6.1 million places, so neither side can be held in memory. The
// ids kept by pass 1 go into sorted typed arrays - 30 MB for both, against roughly half a
// gigabyte for the equivalent Map - and the alternates are written back out per country.
// ---------------------------------------------------------------------------
const altSource = join(src, "alternateNamesV2.txt");
const haveAlternates = existsSync(altSource);

if (haveAlternates) {
    const order = keptIds.map((_, i) => i).sort((a, b) => keptIds[a] - keptIds[b]);
    const sortedIds = new Int32Array(order.length);
    const sortedCc = new Array(order.length);
    for (let i = 0; i < order.length; i++) {
        sortedIds[i] = keptIds[order[i]];
        sortedCc[i] = keptCc[order[i]];
    }
    keptIds.length = 0;
    keptCc.length = 0;

    const countryOf = (id) => {
        let lo = 0;
        let hi = sortedIds.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (sortedIds[mid] === id) {
                return sortedCc[mid];
            }
            if (sortedIds[mid] < id) {
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return null;
    };

    const altBuffers = new Map();
    const flushAlt = (cc) => {
        const buf = altBuffers.get(cc);
        if (buf && buf.length) {
            appendFileSync(join(work, cc + ".alt"), buf.join("\n") + "\n");
            buf.length = 0;
        }
    };

    let altRead = 0;
    let altKept = 0;
    process.stdout.write("pass 2  reading alternate names ");
    const altLines = createInterface({ input: createReadStream(altSource, "utf8"), crlfDelay: Infinity });
    for await (const line of altLines) {
        altRead++;
        if (altRead % 2000000 === 0) {
            process.stdout.write(".");
        }
        const a = line.split("\t");
        const name = a[3];
        if (!name || name.length > 60 || a[7] === "1") {
            // No name, implausibly long, or flagged historic.
            continue;
        }
        const lang = (a[2] || "").toLowerCase();
        if (NOT_A_LANGUAGE.has(lang) || !isLatin(name)) {
            continue;
        }
        const id = Number(a[1]);
        const cc = countryOf(id);
        if (!cc) {
            continue;
        }
        const langs = countryLanguages.get(cc);
        const isCode = CODE_LANGUAGE.has(lang);
        // An empty language is GeoNames' "no language stated", which is overwhelmingly the
        // local form of the name, so it is kept for the country it belongs to.
        if (!isCode && lang !== "" && !(langs && langs.has(lang))) {
            continue;
        }
        /**
         * Rank, so the per-place cap keeps the names worth having. Preferred and short names
         * first, then the country's own languages, then English, then the unstated ones.
         */
        let rank = 4;
        if (a[4] === "1") {
            rank = 0;
        } else if (a[5] === "1") {
            rank = 1;
        } else if (lang && lang !== "en" && !isCode) {
            rank = 2;
        } else if (lang === "en") {
            rank = 3;
        }
        altKept++;
        let buf = altBuffers.get(cc);
        if (!buf) {
            buf = [];
            altBuffers.set(cc, buf);
        }
        buf.push(a[1] + "\t" + rank + "\t" + name.replace(/[\r\n\t]+/g, " "));
        if (buf.length >= FLUSH) {
            flushAlt(cc);
        }
    }
    for (const cc of altBuffers.keys()) {
        flushAlt(cc);
    }
    console.log("\n        " + altRead.toLocaleString() + " read, " + altKept.toLocaleString() + " kept");
}

// ---------------------------------------------------------------------------
// Pass 3 - one shard per country.
// ---------------------------------------------------------------------------
const a1Codes = [];
const a1Index = new Map();
const a2Codes = [];
const a2Index = new Map();
const fcCodes = [];
const fcIndex = new Map();
const intern = (list, index, value) => {
    let at = index.get(value);
    if (at === undefined) {
        at = list.length;
        index.set(value, at);
        list.push(value);
    }
    return at;
};

/** Running mean position of each subdivision and county, for the area fallbacks. */
const a1Sum = [];
const a2Sum = [];

const shards = {};
const files = readdirSync(work).filter((f) => f.endsWith(".tsv")).sort();
console.log("pass 3  building shards");
for (const file of files) {
    const cc = file.slice(0, -4);
    const rows = readFileSync(join(work, file), "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));

    /**
     * This country's chosen alternate names, best first. Read per country so that only one
     * country's worth is ever in memory at once.
     */
    const altFor = new Map();
    const altPath = join(work, cc + ".alt");
    if (existsSync(altPath)) {
        const pending = [];
        for (const line of readFileSync(altPath, "utf8").split("\n")) {
            if (!line) {
                continue;
            }
            const t = line.split("\t");
            pending.push([t[0], Number(t[1]), t[2]]);
        }
        pending.sort((a, b) => a[1] - b[1]);
        for (const entry of pending) {
            let list = altFor.get(entry[0]);
            if (!list) {
                list = [];
                altFor.set(entry[0], list);
            }
            if (list.length < 6) {
                list.push(entry[2]);
            }
        }
    }
    // Longitude order keeps the deltas small; the secondary sort makes the build reproducible.
    rows.sort((a, b) => Number(a[4]) - Number(b[4]) || Number(a[3]) - Number(b[3]) || (a[0] < b[0] ? -1 : 1));

    const lon = [];
    const lat = [];
    const a1Ref = [];
    const a2Ref = [];
    const fcRef = [];
    const pop = [];
    const names = [];
    const keyPairs = [];

    rows.forEach((r, i) => {
        // Pass 1 now writes the geonameid first, so every other field shifted by one.
        const geonameid = r[0];
        const name = r[1];
        const ascii = r[2];
        const embeddedAlt = r[3];
        const fcode = r[6] || "PPL";
        const admin1 = r[7];
        const admin2 = r[8];
        const a1Key = admin1 ? cc + "." + admin1 : "";
        const a2Key = admin1 && admin2 ? cc + "." + admin1 + "." + admin2 : "";
        const lonInt = Math.round(Number(r[5]) * SCALE);
        const latInt = Math.round(Number(r[4]) * SCALE);
        lon.push(lonInt);
        lat.push(latInt);
        const at1 = a1Key ? intern(a1Codes, a1Index, a1Key) : -1;
        a1Ref.push(at1);
        const at2 = a2Key && a2Name.has(a2Key) ? intern(a2Codes, a2Index, a2Key) : -1;
        a2Ref.push(at2);
        fcRef.push(intern(fcCodes, fcIndex, fcode));
        pop.push(Number(r[9]) || 0);
        names.push(name.replace(/[\r\n\t]+/g, " "));

        if (!NOT_A_SETTLEMENT.has(fcode)) {
            if (at1 >= 0) {
                let sum = a1Sum[at1];
                if (!sum) {
                    sum = a1Sum[at1] = [0, 0, 0];
                }
                sum[0] += lonInt;
                sum[1] += latInt;
                sum[2]++;
            }
            if (at2 >= 0) {
                let sum = a2Sum[at2];
                if (!sum) {
                    sum = a2Sum[at2] = [0, 0, 0];
                }
                sum[0] += lonInt;
                sum[1] += latInt;
                sum[2]++;
            }
        }

        // Every distinct folded form of this place points at this row.
        const seen = new Set();
        const add = (value) => {
            const k = fold(value);
            if (!k || seen.has(k)) {
                return false;
            }
            seen.add(k);
            keyPairs.push([k, i]);
            return true;
        };
        add(name);
        add(ascii);
        /**
         * GeoNames names most former places "Mustang Field (historical)", and a few current
         * ones "Washington (township)". Folding keeps the parenthetical - it becomes
         * "mustangfieldhistorical" - so the entry is unreachable by the only name anyone
         * would type.
         *
         * Indexing the stripped form too costs one key on the small minority of rows that
         * have a parenthetical, and is what makes the former-place entries answerable at all.
         * They still cannot outrank a living town, because they are ranked last.
         */
        const bare = /\([^)]*\)\s*$/;
        if (bare.test(name)) {
            add(name.replace(bare, ""));
        }
        if (bare.test(ascii)) {
            add(ascii.replace(bare, ""));
        }
        // The language-filtered names where we have them, the embedded column only as a
        // fallback for a build run without alternateNamesV2.
        const chosen = altFor.get(geonameid);
        if (chosen) {
            for (const one of chosen) {
                add(one);
            }
            if (facilityCode(fcode)) {
                // Facilities also keep the short identifiers - KBED, TLV - which live in the
                // embedded column under no language at all.
                for (const one of pickAlternates(name, ascii, embeddedAlt, fcode)) {
                    add(one);
                }
            }
        } else {
            for (const one of pickAlternates(name, ascii, embeddedAlt, fcode)) {
                add(one);
            }
        }
    });

    // Front-code the sorted keys against their predecessor. Folded keys are [a-z0-9] only, so
    // newline is safe as a separator and the shared-prefix length fits in one printable char.
    keyPairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    const MAX_PREFIX = 60;
    let previous = "";
    const prefixes = [];
    const suffixes = [];
    for (const pair of keyPairs) {
        const k = pair[0];
        let n = 0;
        while (n < k.length && n < previous.length && n < MAX_PREFIX && k[n] === previous[n]) {
            n++;
        }
        prefixes.push(String.fromCharCode(48 + n));
        suffixes.push(k.slice(n));
        previous = k;
    }

    const delta = (arr) => arr.map((v, i) => (i ? v - arr[i - 1] : v));
    const payload = {
        lon: delta(lon),
        lat: delta(lat),
        a1: a1Ref,
        a2: a2Ref,
        fc: fcRef,
        pop,
        n: names.join("\n"),
        kp: prefixes.join(""),
        ks: suffixes.join("\n"),
        ki: keyPairs.map((p) => p[1]),
    };
    // A plain script tag, not a fetch: the browser blocks fetch() of a sibling file on
    // file://, which is exactly how this app is meant to be opened.
    writeFileSync(join(out, cc + ".js"), "GAZ(" + JSON.stringify(cc) + "," + JSON.stringify(payload) + ")\n");
    shards[cc] = { rows: lon.length, keys: keyPairs.length, bytes: statSync(join(out, cc + ".js")).size };
}

// ---------------------------------------------------------------------------
// Anchors for a row that names no city.
// ---------------------------------------------------------------------------

/**
 * Where a country-only row lands: the centroid of that country's largest landmass.
 *
 * The largest-piece rule is what makes it usable, and the Flow Map learned both traps the
 * hard way. A whole-feature centroid for the USA falls in the Pacific between Alaska, Hawaii
 * and the mainland. Deriving the point from city positions is worse: population-weighted,
 * Canada lands in Lake Superior on the US side of the border, because Canadian cities all hug
 * the southern edge.
 */
const basemap = JSON.parse(readFileSync(join(root, "scripts", "countries-50m.json"), "utf8"));
const countryPoint = {};
const countryArea = {};
for (const f of feature(basemap, basemap.objects.countries).features) {
    const a2 = numericTo2.get(String(Number(f.id)));
    if (!a2 || !f.geometry) {
        continue;
    }
    // Several basemap features can share a country code: Natural Earth carries external
    // territories as their own admin-0 features, so Australia also arrives as Ashmore and
    // Cartier Islands. Taking the last one silently anchored Australia in the Timor Sea.
    let target = f;
    let largest = -1;
    if (f.geometry.type === "MultiPolygon") {
        for (const rings of f.geometry.coordinates) {
            const piece = { type: "Feature", properties: null, geometry: { type: "Polygon", coordinates: rings } };
            const area = geoArea(piece);
            if (area > largest) {
                largest = area;
                target = piece;
            }
        }
    } else {
        largest = geoArea(f);
    }
    if (largest <= (countryArea[a2] === undefined ? -1 : countryArea[a2])) {
        continue;
    }
    const c = geoCentroid(target);
    if (Number.isFinite(c[0]) && Number.isFinite(c[1])) {
        countryArea[a2] = largest;
        countryPoint[a2] = [Math.round(c[0] * SCALE), Math.round(c[1] * SCALE)];
    }
}

/**
 * Where a subdivision is drawn: the mean position of the places it contains.
 *
 * Needs no extra data and works everywhere - GeoNames has no geometry, and bundling polygons
 * for every subdivision on earth is not on the table. It lands near the populated middle of
 * the subdivision, which is the right answer far more often than it is not, and it is only
 * ever used behind an off-by-default setting and always labelled approximate.
 */
const a1Point = a1Codes.map((_, i) => {
    const sum = a1Sum[i];
    return sum && sum[2] > 0 ? [Math.round(sum[0] / sum[2]), Math.round(sum[1] / sum[2])] : null;
});

// Resolve the declared subdivision aliases to whatever admin1 code GeoNames actually uses.
const a1Alias = {};
for (const entry of Object.entries(A1_ALIASES)) {
    const cc = entry[0];
    for (const pair of Object.entries(entry[1])) {
        const wanted = fold(pair[1]);
        const found = a1Codes.findIndex((full) => full.startsWith(cc + ".") && fold(a1Name.get(full) || "") === wanted);
        if (found >= 0) {
            a1Alias[cc + "|" + pair[0]] = found;
        } else {
            console.warn("  note: " + cc + " subdivision \"" + pair[1] + "\" not in this extract - alias " + pair[0] + " skipped");
        }
    }
}

const ccc = Object.keys(shards).sort();
const index = {
    scale: SCALE,
    ccc,
    ccn: ccc.map((cc) => displayName.get(cc) || cc),
    a3: Object.fromEntries([...iso3to2].filter((e) => ccc.includes(e[1])).map((e) => [e[0], ccc.indexOf(e[1])])),
    cn: Object.fromEntries([...nameTo2].filter((e) => ccc.includes(e[1])).map((e) => [e[0], ccc.indexOf(e[1])])),
    cp: countryPoint,
    a1c: a1Codes,
    a1n: a1Codes.map((code) => a1Name.get(code) || ""),
    a1p: a1Point,
    a1a: a1Alias,
    a2n: a2Codes.map((code) => a2Name.get(code) || ""),
    /**
     * Counties, so a row whose city column actually holds an administrative area still lands
     * somewhere. UK data does this constantly - "Buckinghamshire" is a county, feature class
     * A, and no populated place carries the name - and the same is true of any export where a
     * region column has been mapped to the city field by mistake.
     *
     * The country prefix is stored as two characters rather than the whole "GB.ENG.Q4" code:
     * it is all the resolver needs to keep an English county apart from a namesake elsewhere,
     * and the index is loaded on every run whether it is used or not.
     */
    a2cc: a2Codes.map((code) => code.slice(0, 2)),
    a2p: a2Codes.map((_, i) => {
        const sum = a2Sum[i];
        return sum && sum[2] > 0 ? [Math.round(sum[0] / sum[2]), Math.round(sum[1] / sum[2])] : null;
    }),
    fcc: fcCodes,
    shards,
};
writeFileSync(join(out, "index.js"), "GAZIDX(" + JSON.stringify(index) + ")\n");
writeFileSync(join(root, "dist", "ATTRIBUTION.txt"),
    "Place data from GeoNames (https://www.geonames.org/), licensed CC BY 4.0.\n"
    + "Country outlines from Natural Earth via world-atlas, public domain.\n");

rmSync(work, { recursive: true, force: true });

const indexBytes = statSync(join(out, "index.js")).size;
const total = Object.values(shards).reduce((s, v) => s + v.bytes, 0) + indexBytes;
const biggest = Object.entries(shards).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8);
console.log("\n  places        " + kept.toLocaleString());
console.log("  countries     " + ccc.length);
console.log("  subdivisions  " + a1Codes.length);
console.log("  counties      " + a2Codes.length);
console.log("  index         " + (indexBytes / 1024).toFixed(0) + " KB (always loaded)");
console.log("  data total    " + (total / 1048576).toFixed(1) + " MB across " + ccc.length + " shards");
console.log("  largest shards");
for (const s of biggest) {
    console.log("    " + s[0] + "  " + String(s[1].rows).padStart(8) + " places  " + (s[1].bytes / 1048576).toFixed(1) + " MB");
}
