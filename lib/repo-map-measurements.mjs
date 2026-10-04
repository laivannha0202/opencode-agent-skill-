// V16.4 Slice I (part 1): repo-map measurement wrapper.
//
// The repo map itself is NOT rewritten: same semantic index, same graph,
// same propagation, same budgets. This module only measures, so a future
// weight/algorithm change must prove itself against these numbers:
//   - top-K recall against known edit sites;
//   - first-correct-file rank;
//   - bytes read before first correct edit (estimated from ranked sizes);
//   - repeated retrieval rate (same query twice);
//   - query latency.

// `ranked` arrives either as a ranked array or as the whole `buildRepoMap`
// packet (`{ files: [...] }`). The production caller passes the packet, because
// the map is built once and measured on the way out; a test or a benchmark may
// pass the array directly. Accepting both is what keeps the wrapper usable
// without rebuilding the map.
function rankedRows(ranked) {
  if (Array.isArray(ranked)) return ranked;
  if (Array.isArray(ranked?.files)) return ranked.files;
  if (Array.isArray(ranked?.rows)) return ranked.rows;
  return [];
}

export function summarizeRepoMapMeasurement({ ranked = [], knownEditSites = [], elapsedMs = null, previousQuery = null } = {}) {
  const rows = rankedRows(ranked);
  const names = rows.map((row) => String(row?.path || row?.file || row));
  const known = knownEditSites.map(String);
  const hits = known.filter((site) => names.includes(site));
  const ranks = hits.map((site) => names.indexOf(site) + 1);
  const firstRank = ranks.length ? Math.min(...ranks) : null;
  let bytesBeforeFirst = null;
  if (firstRank !== null) {
    bytesBeforeFirst = 0;
    for (let i = 0; i < firstRank - 1; i += 1) {
      const size = Number(rows[i]?.chars ?? rows[i]?.size ?? 0);
      if (Number.isFinite(size)) bytesBeforeFirst += size;
    }
  }
  const repeated = previousQuery != null && String(previousQuery) === names.join("\n");
  return {
    topKRecall: known.length ? hits.length / known.length : null,
    editSiteRecall: hits.length,
    editSiteTotal: known.length,
    firstCorrectFileRank: firstRank,
    bytesReadBeforeFirstCorrectEdit: bytesBeforeFirst,
    repeatedRetrieval: repeated,
    queryLatencyMs: elapsedMs,
    measuredAt: new Date().toISOString(),
  };
}

export async function measureRepoMapQuery(queryFn, args = {}, knownEditSites = []) {
  const started = Date.now();
  const produced = await queryFn(args);
  const elapsedMs = Date.now() - started;
  return {
    ranked: produced,
    measurement: summarizeRepoMapMeasurement({ ranked: produced, knownEditSites, elapsedMs }),
  };
}
