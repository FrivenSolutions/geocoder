/**
 * The lookup-table output: one row per distinct location rather than one per input row.
 *
 * A file of four million shipments might name forty thousand places. Geocoding it row by row
 * repeats "Boston, MA, US" twelve thousand times, produces a result file as long as the
 * input, and leaves whoever receives it to deduplicate before it is any use in a database.
 * This emits the distinct locations instead, so the result is a dimension table that joins
 * back to the source on the columns it came from.
 *
 * It is also much faster, because a place is resolved once rather than once per mention.
 */

import { resultCells, RESULT_COLUMNS } from "./locate.js";

/**
 * The join key: the location cells exactly as the source wrote them, including case.
 *
 * Deliberately NOT normalized. The point of this file is to join back to the source table,
 * and a join matches the bytes that are there - so if a source holds both "Boston" and
 * "BOSTON", two rows are correct and one would break half the join. Normalizing here would
 * force every consumer to apply the same normalization on both sides of the ON clause, and
 * any disagreement about it would silently drop rows.
 *
 * The unit separator cannot appear in a CSV field in practice, so it cannot collide with
 * content the way a comma or a pipe could.
 */
export function lookupKey(cells) {
    return cells.map((v) => String(v == null ? "" : v)).join("\u001f");
}

/**
 * Collects distinct locations and their results.
 *
 * `headers` are the source's own column names for whichever cells form the key, so the output
 * carries the names the join will be written against rather than invented ones. The caller
 * decides what those cells are: the separate city, state and country columns where the file
 * has them, or the single combined column where it does not - which is why the key is passed
 * in rather than derived from the parsed fields. A file with one "Location" column has to
 * join on that column's exact text, not on the pieces it was split into.
 */
export function createLookupTable(headers) {
    const seen = new Map();

    return {
        /**
         * Records one input row, resolving it only if this location has not been seen.
         *
         * `produce` is called lazily and at most once per distinct location - that laziness
         * is the speed of this mode, not an optimization detail. Twelve thousand rows saying
         * "Boston, MA, US" cost one lookup. Returns the new result, or null for a repeat.
         */
        addOnce(cells, produce) {
            const key = lookupKey(cells);
            const existing = seen.get(key);
            if (existing) {
                existing.count++;
                return null;
            }
            const result = produce();
            seen.set(key, {
                cells: cells.map((v) => String(v == null ? "" : v)),
                result: result,
                count: 1,
            });
            return result;
        },

        get size() {
            return seen.size;
        },

        header() {
            // "Rows" last, so the geocoding columns sit in the same order as the other output.
            return headers.concat(RESULT_COLUMNS).concat(["Rows"]);
        },

        /** The distinct rows, in the order the locations were first seen. */
        rows() {
            const out = [];
            for (const entry of seen.values()) {
                out.push(entry.cells.concat(resultCells(entry.result)).concat([String(entry.count)]));
            }
            return out;
        },
    };
}
