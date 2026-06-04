import type { DatasetConfig } from "./types";
import { LUBLIN } from "./lublin";

// Registry of all known datasets, keyed by `id`. Add new datasets by importing
// their config here and adding an entry to `DATASETS`.
export const DATASETS: Record<string, DatasetConfig> = {
    [LUBLIN.id]: LUBLIN,
};

export const DEFAULT_DATASET_ID = LUBLIN.id;

/** Pick a dataset from the URL `?dataset=<id>` query parameter, falling back
 *  to the default when missing or unknown. */
export function pickDatasetFromUrl(): DatasetConfig {
    const id = new URLSearchParams(window.location.search).get("dataset");
    if (id && DATASETS[id]) return DATASETS[id];
    if (id) {
        console.warn(
            `[datasets] unknown dataset id "${id}"; falling back to "${DEFAULT_DATASET_ID}". ` +
                `Known ids: ${Object.keys(DATASETS).join(", ")}`,
        );
    }
    return DATASETS[DEFAULT_DATASET_ID];
}

export type { DatasetConfig } from "./types";
