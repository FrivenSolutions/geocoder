#!/usr/bin/env node
/**
 * Exercises the resolver against the real shards.
 *
 *   node test/run-tests.mjs
 *
 * gazetteer.js registers its callbacks on `window` and loads shards with a script tag, both of
 * which only exist in a browser. Rather than abstract that away - the script tag is load-
 * bearing, since it is what makes file:// work - the harness shims the two globals and feeds
 * the shard files in directly. What is under test is the decoding and the resolution, which is
 * where the ways to be silently wrong live.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = join(root, "dist", "data");
if (!existsSync(join(data, "index.js"))) {
    console.error("No data built. Run: node scripts/build-gazetteer.mjs <geonames-dir>");
    process.exit(1);
}

globalThis.window = globalThis;
globalThis.document = { createElement: () => ({}), head: { appendChild: () => {} } };

const { locate, splitCombined, resolveCountry, effectiveCountry } = await import("../src/locate.js");
const { getIndex } = await import("../src/gazetteer.js");

const feed = (file) => new Function(readFileSync(join(data, file), "utf8"))();
feed("index.js");
const loaded = new Set();
const need = (cc) => {
    if (!loaded.has(cc) && existsSync(join(data, cc + ".js"))) {
        feed(cc + ".js");
        loaded.add(cc);
    }
};

let pass = 0;
let fail = 0;

/**
 * `expect` is either coordinates to land near, or a string the failure message must contain.
 * Checking the message and not just "it failed" matters: a row that fails for the wrong reason
 * sends the user to fix the wrong thing.
 */
function check(label, input, expect, options) {
    const fields = typeof input === "string" ? splitCombined(input) : input;
    const country = effectiveCountry(fields.country || (options && options.defaultCountry) || "", fields.state);
    if (country !== null) {
        need(getIndex().ccc[country]);
    }
    const got = locate(fields, options || {});
    let ok;
    let detail;
    if (typeof expect === "string") {
        ok = Boolean(got.error) && got.error.toLowerCase().includes(expect.toLowerCase());
        detail = got.error || ("resolved to " + got.lat + ", " + got.lon + " (" + got.place + ")");
    } else {
        const near = got.lat !== undefined
            && Math.abs(got.lat - expect[0]) < (expect[2] || 0.2)
            && Math.abs(got.lon - expect[1]) < (expect[2] || 0.2);
        ok = near;
        detail = got.error || (got.lat.toFixed(4) + ", " + got.lon.toFixed(4) + "  " + got.place);
    }
    if (ok) {
        pass++;
        console.log("  ok    " + label.padEnd(42) + detail);
    } else {
        fail++;
        console.log("  FAIL  " + label.padEnd(42) + detail);
    }
}

/** Asserts the weaker ambiguity rule reports itself distinctly from the stronger one. */
function checkChosen(label, input) {
    const country = effectiveCountry(input.country, input.state);
    if (country !== null) {
        need(getIndex().ccc[country]);
    }
    const got = locate(input, { ambiguity: "inhabited" });
    const ok = got.lat !== undefined && got.onlyInhabited === true && got.dominant === false;
    if (ok) {
        pass++;
        console.log("  ok    " + label.padEnd(42) + "onlyInhabited, not dominant  -> " + got.place);
    } else {
        fail++;
        console.log("  FAIL  " + label.padEnd(42) + (got.error || "onlyInhabited=" + got.onlyInhabited + " dominant=" + got.dominant));
    }
}

/** Asserts two inputs do NOT collapse onto the same place. */
function checkDistinct(label, a, b) {
    const one = [a, b].map((q) => {
        const f = splitCombined(q);
        const c = resolveCountry(f.country);
        if (c !== null) {
            need(getIndex().ccc[c]);
        }
        return locate(f, {});
    });
    const both = one.every((r) => r.lat !== undefined);
    const apart = both && (one[0].lat !== one[1].lat || one[0].lon !== one[1].lon);
    if (apart) {
        pass++;
        console.log("  ok    " + label.padEnd(42) + one.map((r) => r.lat + "," + r.lon).join("  vs  "));
    } else {
        fail++;
        console.log("  FAIL  " + label.padEnd(42) + (both ? "same point - they were merged" : "one did not resolve"));
    }
}

/** Asserts what a matched row says about itself, rather than where it landed. */
function checkFlag(label, input, expectCaveat) {
    const fields = typeof input === "string" ? splitCombined(input) : input;
    const country = effectiveCountry(fields.country, fields.state);
    if (country !== null) {
        need(getIndex().ccc[country]);
    }
    const got = locate(fields, {});
    const caveat = got.caveat === undefined ? "(not matched)" : got.caveat;
    const ok = got.lat !== undefined && (expectCaveat
        ? caveat.includes(expectCaveat)
        : caveat === "");
    const detail = got.error || (got.kind + "  " + (caveat || "no caveat"));
    if (ok) {
        pass++;
        console.log("  ok    " + label.padEnd(42) + detail);
    } else {
        fail++;
        console.log("  FAIL  " + label.padEnd(42) + detail);
    }
}


/** Asserts an area-centre result names the area it was placed at, and at which level. */
function checkArea(label, input, expectKind, expectName) {
    const fields = typeof input === "string" ? splitCombined(input) : input;
    const country = effectiveCountry(fields.country, fields.state);
    if (country !== null) {
        need(getIndex().ccc[country]);
    }
    const got = locate(fields, { ambiguousFallback: "area" });
    const ok = got.lat !== undefined && got.sharedArea === true && got.approximate === true
        && got.kind === expectKind && String(got.place).includes(expectName)
        && String(got.adjusted).includes("share " + expectName);
    const detail = got.error || (got.kind + "  " + got.place + "  [" + got.adjusted + "]");
    if (ok) {
        pass++;
        console.log("  ok    " + label.padEnd(42) + detail);
    } else {
        fail++;
        console.log("  FAIL  " + label.padEnd(42) + detail);
    }
}
console.log("\nThe three the Flow Map's coverage note called unreachable");
// All present now: the first two because no population threshold is applied at all, the third
// because the facility slice carries feature class S, which no cities* file does.
check("Andover, MA", "Andover|MA|USA", [42.6583, -71.1368]);
check("Moorestown, NJ", "Moorestown|NJ|USA", [39.9687, -74.9488]);
check("Hanscom AFB", "Hanscom AFB|MA|USA", [42.4700, -71.2890]);

console.log("\nMilitary sites, by the name people actually write");
check("Hanscom Air Force Base", "Hanscom Air Force Base|MA|USA", [42.4700, -71.2890]);
check("Fort Bragg, NC", "Fort Bragg|NC|USA", [35.1390, -79.0060, 0.4]);
check("Camp Lejeune", "Camp Lejeune|NC|USA", [34.6400, -77.3400, 0.4]);
check("Ramstein AB, Germany", "Ramstein Air Base||DEU", [49.4369, 7.6003, 0.4]);
check("Yokota AB, Japan", "Yokota Air Base||JPN", [35.7486, 139.3486, 0.4]);

console.log("\nOrdinary places");
check("Springfield, IL", "Springfield|IL|USA", [39.8017, -89.6437]);
check("Paris, TX", "Paris|TX|USA", [33.6609, -95.5555]);
check("Paris, France", "Paris||FRA", [48.8534, 2.3488]);
check("Rotterdam (no subdivision)", "Rotterdam||NLD", [51.9225, 4.4792]);
check("Rotterdam, Zuid-Holland", "Rotterdam|Zuid-Holland|NLD", [51.9225, 4.4792]);
check("London, ON (alias code)", "London|ON|CAN", [42.9834, -81.2330]);
check("Zurich accented", "Zürich||CHE", [47.3667, 8.5500]);
check("Kirklareli, Turkey", "Kırklareli||TUR", [41.7333, 27.2167]);
check("St. Louis, MO", "St. Louis|MO|USA", [38.6270, -90.1994]);
check("Saint Louis, MO", "Saint Louis|MO|USA", [38.6270, -90.1994]);
check("Washington, D.C.", "Washington|DC|USA", [38.8951, -77.0364]);
check("Tel Aviv-Yafo", "Tel Aviv-Yafo||ISR", [32.0853, 34.7818]);

console.log("\nCountry naming");
check("alpha-2", "Seoul||KR", [37.5683, 126.9778]);
check("alpha-3", "Seoul||KOR", [37.5683, 126.9778]);
check("inverted ISO name, pipe-split", "Seoul||Korea, Republic of", [37.5683, 126.9778]);
check("inverted ISO name, comma-split", "Seoul,,Korea, Republic of", "unknown country");
check("common name", "Munich||Germany", [48.1374, 11.5755]);
check("The Netherlands", "Rotterdam||The Netherlands", [51.9225, 4.4792]);

console.log("\nSeparate columns, and a default country");
check("city+state, default USA", { city: "Andover", state: "MA", county: "", country: "" }, [42.6583, -71.1368], { defaultCountry: "US" });
check("county breaks a tie", { city: "Springfield", state: "", county: "Sangamon", country: "US" }, [39.8017, -89.6437]);
check("no country at all", { city: "Andover", state: "MA", county: "", country: "" }, "no country given");

console.log("\nRefusals - these must NOT resolve");
check("ambiguous without a state", { city: "Springfield", state: "", county: "", country: "USA" }, "ambiguous");
check("unknown country", "Somewhere||Freedonia", "unknown country");
check("no such place", "Xqzzyville|MA|USA", "no place of that name");
check("real city, wrong state", "Boston|CA|USA", "no \"boston\" in california");
check("empty", { city: "", state: "", county: "", country: "" }, "no country given");

console.log("\nRows that name no city");
check("country only", "||AUS", [-25.0, 134.0, 6]);
check("state only", "|Texas|USA", [31.0, -99.0, 4]);
check("state only, unknown state", "|Freedonia|USA", "not a subdivision");

console.log("\nA number stuck on the front of the name");
// Dropped only on a retry, after the name as written has already missed.
check("0409 Singapore", "0409 Singapore||SGP", [1.2897, 103.8501, 0.6]);
check("01 Dakar", "01 Dakar||SEN", [14.6937, -17.4441, 0.6]);
check("0114 Oslo", "0114 Oslo||NOR", [59.9127, 10.7461, 0.6]);
check("no number, unaffected", "Oslo||NOR", [59.9127, 10.7461, 0.6]);
// The reason it is a retry and not a fold rule: these must stay distinct.
check("Al Majaz 1 keeps its digit", { city: "Al Majaz 1", state: "", county: "", country: "ARE" }, [25.33, 55.38, 0.5]);
check("Al Majaz 3 is a different place", { city: "Al Majaz 3", state: "", county: "", country: "ARE" }, [25.33, 55.38, 0.5]);
checkDistinct("Al Majaz 1 and 3 are not the same point", "Al Majaz 1||ARE", "Al Majaz 3||ARE");

console.log("\nA county or region in the city column");
// UK exports do this constantly. Answered with the area anchor, flagged approximate.
check("Buckinghamshire, a county", "Buckinghamshire||GBR", [51.8, -0.8, 1.2]);
check("Antrim still finds the town", "Antrim||GBR", [54.7195, -6.2072, 0.3]);
check("Belfast still finds the city", "Belfast||GBR", [54.5964, -5.9301, 0.3]);
check("Bedford still finds the town", "Bedford||GBR", [52.1350, -0.4667, 0.3]);

console.log("\nTownships and administrative areas");
// GeoNames files a US township as ADM3 named "Township of Parker", never as a populated
// place, so no depth in class P could reach one. Both word orders must land on it.
check("Township of Moorestown", "Township of Moorestown|NJ|USA", [39.96, -74.94, 0.3]);
check("Moorestown Township, as written", "Moorestown Township|NJ|USA", [39.96, -74.94, 0.3]);
check("the town still wins over the township", "Moorestown|NJ|USA", [39.9671, -74.9427, 0.1]);
// Moorestown resolves to the TOWN for both spellings, and should: the populated place carries
// "Moorestown Township" among its alternate names, so an exact point beats the area. A
// township only answers for itself where no settlement shares the name.
check("a township with no town of the name", "Township of Lost River|IN|USA", [38.5, -86.4, 1.5]);
checkFlag("that township is an area, not a point", "Township of Lost River|IN|USA", "administrative area");
check("Buckinghamshire, now a real record", "Buckinghamshire||GBR", [51.8, -0.8, 1.2]);
checkFlag("Buckinghamshire is flagged as an area", "Buckinghamshire||GBR", "administrative area");
checkFlag("Bedford is still the town", "Bedford||GBR", "");

console.log("\nHarbours - 6,220 of them, previously dropped by a class mismatch");
check("Stromness Harbour", "Stromness Harbour||GBR", [58.96, -3.29, 0.5]);

console.log("\nForts and other military additions");
check("Fort Ticonderoga", "Fort Ticonderoga|NY|USA", [43.84, -73.38, 0.3]);

console.log("\nFormer and minor places are matched, but flagged");
// Carried so a historical address still resolves, ranked last so they never win a tie, and
// marked so a live dataset can show whether carrying them was worth it.
checkFlag("Blakeley, AL - historical", "Blakeley|AL|USA", "abandoned, destroyed or historical");
/**
 * Attu is the abandoned village, and asking for it should return it - flagged.
 *
 * This expected the opposite until language-filtered alternate names arrived. Attu Station,
 * a separate place of 21 people, had been carrying "Attu" as an unfiltered alternate, so the
 * tier rule preferred the inhabited one and the test called that a success. It was the data
 * that was wrong, not the rule: the two are different places and each now answers to its own
 * name.
 */
checkFlag("Attu, AK is the abandoned village", "Attu|AK|USA", "abandoned, destroyed or historical");
check("Attu Station is its own place", "Attu Station|AK|USA", [52.83, 173.18, 0.6]);
checkFlag("Mustang Field, TX - abandoned airfield", "Mustang Field|TX|USA", "abandoned, destroyed or historical");
checkFlag("Bay View Estates, AL - section", "Bay View Estates|AL|USA", "section or locality");
checkFlag("Andover, MA - an ordinary town", "Andover|MA|USA", "");
checkFlag("Hanscom AFB - a facility", "Hanscom AFB|MA|USA", "");

console.log("\nDominant-match setting, off by default");
// The point of the thresholds is that the first pair flips and the second pair does not.
check("Busan, setting off", "Busan||KOR", "ambiguous");
check("Busan, setting on", "Busan||KOR", [35.1028, 129.0403], { acceptDominant: true });
check("Springfield, setting on", { city: "Springfield", state: "", county: "", country: "USA" }, "ambiguous", { acceptDominant: true });
check("Paris needs no setting", "Paris||FRA", [48.8534, 2.3488]);

console.log("\nThe lookup table: one row per distinct place");
{
    const { createLookupTable } = await import("../src/lookup.js");
    const table = createLookupTable(["City", "State", "Country"]);
    const resolve = (city, state, country) => () => {
        const c = effectiveCountry(country, state);
        if (c !== null) {
            need(getIndex().ccc[c]);
        }
        return locate({ city, state, county: "", country }, { ambiguity: "inhabited" });
    };
    let calls = 0;
    const counted = (city, state, country) => () => {
        calls++;
        return resolve(city, state, country)();
    };
    for (let i = 0; i < 12; i++) {
        table.addOnce(["Boston", "MA", "USA"], counted("Boston", "MA", "USA"));
    }
    table.addOnce(["Springfield", "IL", "USA"], counted("Springfield", "IL", "USA"));
    table.addOnce(["BOSTON", "MA", "USA"], counted("BOSTON", "MA", "USA"));

    const rows = table.rows();
    const expectSize = table.size === 3;
    const expectCalls = calls === 3;
    const boston = rows.find((r) => r[0] === "Boston");
    const expectCount = boston && boston[boston.length - 1] === "12";
    // Case differs, so these are two keys on purpose: a join matches the bytes that are there.
    const expectCase = rows.some((r) => r[0] === "BOSTON");
    const expectHeader = table.header().join(",")
        === "City,State,Country,Latitude,Longitude,Matched Place,Match Type,Status,Rows";
    for (const [label, got] of [
        ["12 Bostons collapse to one row", expectSize],
        ["resolved once per place, not per row", expectCalls],
        ["the Rows column counts them", expectCount],
        ["different case stays a separate key", expectCase],
        ["the header names the source columns", expectHeader],
    ]) {
        if (got) {
            pass++;
            console.log("  ok    " + label);
        } else {
            fail++;
            console.log("  FAIL  " + label + "   size=" + table.size + " calls=" + calls);
        }
    }
}

console.log("\nTerritories that GeoNames files as their own countries");
// "San Juan, PR, USA" is how every US system writes a Puerto Rican address, but there is no
// US.PR subdivision - PR is a country with its own shard.
check("San Juan, PR, USA", "San Juan|PR|USA", [18.4663, -66.1057, 0.3]);
check("Ponce, PR, USA", "Ponce|PR|USA", [18.0111, -66.6141, 0.3]);
check("Charlotte Amalie, VI, USA", "Charlotte Amalie|VI|USA", [18.3419, -64.9307, 0.3]);
check("Hagatna, GU, USA", "Hagatna|GU|USA", [13.4745, 144.7504, 0.3]);
check("Saipan, MP, USA", "Saipan|MP|USA", [15.2123, 145.7545, 0.4]);
// These two were worse than misses: the parent country had a namesake and won silently.
check("Douglas, IM, GBR is the Manx one", "Douglas|IM|GBR", [54.1500, -4.4819, 0.2]);
check("Saint Helier, JE, GBR is the Jersey one", "Saint Helier|JE|GBR", [49.1869, -2.1070, 0.2]);
check("Fort-de-France, MQ, FRA", "Fort-de-France|MQ|FRA", [14.6036, -61.0667, 0.3]);
check("Oranjestad, AW, NLD", "Oranjestad|AW|NLD", [12.5240, -70.0270, 0.3]);
// A real US state must not be mistaken for a territory.
check("Portland, OR, USA still works", "Portland|OR|USA", [45.5234, -122.6762, 0.2]);
check("Providence, RI, USA still works", "Providence|RI|USA", [41.8240, -71.4128, 0.2]);

console.log("\nSettlement-type words, and CITY - DISTRICT");
check("MOSHAV TNUVOT", "MOSHAV TNUVOT||ISRAEL", [32.31, 34.94, 0.4]);
check("KIBBUTZ EYAL", "KIBBUTZ EYAL||ISRAEL", [32.23, 34.94, 0.4]);
check("KAZANLAK TOWN", "KAZANLAK TOWN||BULGARIA", [42.62, 25.39, 0.4]);
check("RAVNO POLE VILLAGE", "RAVNO POLE VILLAGE||BULGARIA", [42.66, 23.52, 0.4]);
check("PRAHA - MODRANY -> Praha", "PRAHA - MODRANY||CZECH REPUBLIC", [50.08, 14.44, 0.4]);
check("KOSICE - MESTSKA CAST SACA", "KOSICE - MESTSKA CAST SACA||SLOVAKIA", [48.72, 21.26, 0.4]);
// Salt Lake City must not lose its "City": it matches as written, so no repair runs.
check("Salt Lake City keeps its name", "Salt Lake City|UT|USA", [40.7608, -111.8911, 0.2]);
check("Mexico City keeps its name", "Mexico City||MEX", [19.43, -99.13, 0.4]);

console.log("\nOnly-one-inhabited, a level above dominant and off by default");
// Real rows from a live dataset. Each matches two places in its own state, one carrying a
// census population and the other none.
check("Greenwood MS, level off", { city: "Greenwood", state: "MS", county: "", country: "USA" }, "ambiguous", { ambiguity: "dominant" });
check("Greenwood MS, level on", { city: "Greenwood", state: "MS", county: "", country: "USA" }, [33.5162, -90.1795, 0.3], { ambiguity: "inhabited" });
check("Marion IL, level on", { city: "Marion", state: "IL", county: "", country: "USA" }, [37.7306, -88.9331, 0.3], { ambiguity: "inhabited" });
check("Lima OH, level on", { city: "Lima", state: "OH", county: "", country: "USA" }, [40.7426, -84.1052, 0.3], { ambiguity: "inhabited" });
// Still refused: several candidates carry a population, so there is a real choice to make.
check("Springfield USA stays ambiguous", { city: "Springfield", state: "", county: "", country: "USA" }, "ambiguous", { ambiguity: "inhabited" });
// A ratio, not a count of how many have a population. An earlier version asked whether
// exactly one candidate had any population at all, and silently stopped firing on these two
// once more alternate names brought a third namesake into the candidate set.
check("Marion IL, rival of 181", { city: "Marion", state: "IL", county: "", country: "USA" }, [37.7306, -88.9331, 0.3], { ambiguity: "inhabited" });
check("Lima OH, rival of 150", { city: "Lima", state: "OH", county: "", country: "USA" }, [40.7426, -84.1052, 0.3], { ambiguity: "inhabited" });
// The weaker rule must be distinguishable from the stronger one in the output.
checkChosen("Greenwood is marked as the inhabited pick", { city: "Greenwood", state: "MS", county: "", country: "USA" });

console.log("\nApproximate fallback, blank by default");
check("missing place, blank", "Notaplaceatall|MA|USA", "no place of that name");
check("missing place, to the state", "Notaplaceatall|MA|USA", [42.2, -71.7, 1.5], { fallback: "state" });
// The state level deliberately cannot help a row with no state - that is what the country
// level is for, and why it is a separate choice rather than the same one.
check("no state, state level cannot help", "Notaplaceatall||FRA", "no place of that name", { fallback: "state" });
check("no state, country level can", "Notaplaceatall||FRA", [46.6, 2.4, 3], { fallback: "country" });
check("country level still prefers the state", "Notaplaceatall|MA|USA", [42.2, -71.7, 1.5], { fallback: "country" });
// A row naming no city at all resolves regardless of the setting: there is nothing else it
// could mean, so it is not a fallback.
check("no city named, no setting", "||AUS", [-25.0, 134.0, 6]);
check("old option name still honoured", "Notaplaceatall|MA|USA", [42.2, -71.7, 1.5], { approximateToSubdivision: true });


console.log("\nAmbiguous rows with one shared area, blank by default");
const AREA = { ambiguousFallback: "area" };
// Four Greenwoods in Indiana, in four different counties. Nothing says which, but all four
// are in Indiana, so Indiana's centre is wrong only by the size of Indiana.
check("Greenwood IN, blank by default", "Greenwood|IN|USA", "ambiguous");
check("Greenwood IN, to the state centre", "Greenwood|IN|USA", [39.91, -86.27, 0.3], AREA);
check("Franklin OH, to the state centre", "Franklin|OH|USA", [40.30, -82.68, 0.3], AREA);
// Where they also share a county the county is used, which is tighter by an order of
// magnitude - 0.1 degrees from the candidates rather than two or three.
check("Roberts FL, to the county centre", "Roberts|FL|USA", [27.98, -82.38, 0.3], AREA);
check("Pleasant Hill ME, to the county centre", "Pleasant Hill|ME|USA", [43.78, -70.31, 0.3], AREA);
check("Bridgetown PA, to the county centre", "Bridgetown|PA|USA", [40.29, -75.08, 0.3], AREA);
checkArea("Roberts FL says it is a county centre", "Roberts|FL|USA", "county centre", "Hillsborough County");
checkArea("Greenwood IN says it is a state centre", "Greenwood|IN|USA", "subdivision centre", "Indiana");
// The case this must NOT touch, and the reason it is keyed on a shared area rather than on
// falling back to the country: Springfield spans Missouri, Massachusetts and Illinois, which
// share nothing smaller than the United States.
check("Springfield USA still ambiguous", "Springfield||USA", "ambiguous", AREA);
check("Springfield USA, with the other rules too", "Springfield||USA", "ambiguous",
    { ambiguity: "inhabited", fallback: "country", ambiguousFallback: "area" });
// An exact answer always beats an approximate one, so a rule that picks a real place runs
// first. Greenwood, Indiana resolves to Johnson County's town at 55,586 under "inhabited".
check("a real match outranks the area centre", "Greenwood|IN|USA", [39.61, -86.11, 0.3],
    { ambiguity: "inhabited", ambiguousFallback: "area" });
// Unambiguous rows are untouched by the setting.
check("unambiguous row unaffected", "Lebanon|PA|USA", [40.3409, -76.4113], AREA);
console.log("\n  " + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
