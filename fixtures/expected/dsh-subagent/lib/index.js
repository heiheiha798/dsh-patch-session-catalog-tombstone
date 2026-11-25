const unknownCatalogSchema = oneShotCatalogSchema.extend({
	version: z$1.literal(1),
	mode: z$1.literal("unknown")
});
const nameSchema = z$1.string().refine(isAgentName, "invalid agent name");
const namedContinuableCatalogSchema = continuableCatalogSchema.extend({
	version: z$1.literal(3),
	name: nameSchema
});
const namedExternalCatalogSchema = externalCatalogSchema.extend({
	version: z$1.literal(3),
	name: nameSchema
});
const removedCatalogSchema = oneShotCatalogSchema.extend({
	version: z$1.literal(3),
	mode: z$1.literal("removed")
});
const eventDataSchema = z$1.union([
	oneShotCatalogSchema,
	externalCatalogSchema,
	continuableCatalogSchema,
	unknownCatalogSchema,
	namedContinuableCatalogSchema,
	namedExternalCatalogSchema,
	removedCatalogSchema
]);
// ---- trimmed fixture region (not executable) ----
function subagentCatalogEntries(state) {
	const entries = [];
	const removed = new Set();
	for (const data of iterateChunkedList(state.head)) {
		if (data.mode === "removed") {
			removed.add(data.childId);
			continue;
		}
		const { version: _version, childId, childCreatedAt, ...descriptor } = data;
		entries.push({
			id: childId,
			createdAt: childCreatedAt,
			...descriptor
		});
	}
	return removed.size === 0 ? entries : entries.filter((entry) => !removed.has(entry.id));
}
/** Parent-owned catalog; version-6 checkpoints retain unnamed facts, and invalid own facts reject restoration. */
const subagentCatalogProjectionDefinition = {
	key: "subagentCatalog",
	stateSchema,
	init: (_header, inheritedEventCount) => ({ inheritedEventCount }),
	apply: (state, event) => {
		if (event.type !== "subagent/catalog" || event.seq < state.inheritedEventCount) return state;
		return {
			...state,
			head: appendChunkedList(state.head, eventDataSchema.parse(event.data))
		};
	},
	stateVersion: 7,
	wire: {
		viewSchema,
		view: subagentCatalogEntries
	}
};
