import type { DatasetConfig } from "./types";
import { KINALIADA } from "./kinaliada";

// Registry of all known datasets, keyed by `id`. Add new datasets by importing
// their config here and adding an entry to `DATASETS`.
// Lublin was retired — its Ion assets were deleted to free quota for the
// Kınalıada upload (free tier is 5 GB total). The `lublin.ts` config file
// is kept on disk as a reference for re-instating it later if quota permits.
export const DATASETS: Record<string, DatasetConfig> = {
    [KINALIADA.id]: KINALIADA,
};

export const DEFAULT_DATASET_ID = KINALIADA.id;

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
