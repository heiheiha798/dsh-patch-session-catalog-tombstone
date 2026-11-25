/**
* Validate the historical fields used for catalog membership without interpreting extensions.
* @param value - catalog payload or prepared historical discovery fact.
* @param subject - event type or child identity used in rejection diagnostics.
* @returns validated catalog payload.
*/
function catalogFact(value, subject = "subagent/catalog") {
	if (!isSessionFormatJsonObject(value) || value["version"] !== 0 && value["version"] !== 1 && value["version"] !== 2 || typeof value["childId"] !== "string" || value["mode"] !== "continuable" && value["mode"] !== "one-shot" && value["mode"] !== "external" && value["mode"] !== "unknown" || value["version"] === 2 !== (value["mode"] === "external") || value["version"] === 0 && value["mode"] === "unknown" || value["mode"] === "continuable" && typeof value["label"] !== "string" || value["label"] !== void 0 && typeof value["label"] !== "string") throw new SessionFormatError(`${subject} requires a supported versioned catalog fact`);
	sessionFormatCount(value["childCreatedAt"], "catalog child creation time");
	return value;
}
/**
* Name the child and its optional storage-owned location in a migration diagnostic.
* @param source - validated supplemental child evidence.
* @returns a child identity with its source path when persistence supplied one.
*/
function childCatalogSubject(source) {
	return `Session ${source["childId"]}${typeof source["sourcePath"] === "string" ? ` (raw log: ${source["sourcePath"]})` : ""}`;
}
// ---- trimmed fixture region (not executable) ----
/**
* Validate native developer fields, message sources, lifecycle, catalog, and delivery
* relationships without changing event vocabulary or tail recovery.
* The owning admission stage rejects unknown required events;
* unknown ignorable records retain their uninterpreted payloads.
* @param artifact - decoded artifact with its final inherited cut.
* @param knownEventTypes - installed event types whose payloads this reader interprets.
*/
function assertReleasedV4Relationships(artifact, knownEventTypes) {
	const ids = /* @__PURE__ */ new Set();
	const names = /* @__PURE__ */ new Set();
	const namesById = /* @__PURE__ */ new Map();
	for (const event of artifact.events) {
		if (!knownEventTypes.has(event.type)) continue;
		assertV4DeveloperData(event);
		assertV4MessageSources(event);
		const deliveryId = validateDeliveryAccepted(event, 4);
		if (deliveryId !== void 0 && event.seq >= artifact.inheritedEventCount && deliveryId !== artifact.header.id) throw new SessionFormatError("current-generation delivery marker names the wrong Session");
		if (event.type === "subagent/catalog" && event.seq >= artifact.inheritedEventCount) {
			const fact = nativeCatalogFact(event.data);
			const id = fact["childId"];
			if (fact["mode"] === "removed") {
				ids.delete(id);
				const retiredName = namesById.get(id);
				if (retiredName !== void 0) {
					names.delete(retiredName);
					namesById.delete(id);
				}
				continue;
			}
			if (ids.has(id)) throw new SessionFormatError(`duplicate catalog child ${id}`);
			ids.add(id);
			if (fact["name"] === void 0) continue;
			const name = fact["name"];
			if (names.has(name)) throw new SessionFormatError(`duplicate catalog child name ${name}`);
			names.add(name);
			namesById.set(id, name);
		}
	}
	assertV4LifecycleRelationships(artifact, knownEventTypes);
}
/**
* Validate an own native V4 catalog payload: a historical version or version 3,
* which adds the child's name and is written only by native V4 creation.
* @param value - native `subagent/catalog` payload.
* @returns validated catalog payload.
*/
function nativeCatalogFact(value) {
	if (isSessionFormatJsonObject(value) && value["version"] === 3 && value["mode"] === "removed" && typeof value["childId"] === "string" && (value["label"] === void 0 || typeof value["label"] === "string")) {
		sessionFormatCount(value["childCreatedAt"], "catalog child creation time");
		return value;
	}
	if (!isSessionFormatJsonObject(value) || value["version"] !== 3) return catalogFact(value);
	if (typeof value["childId"] !== "string" || value["mode"] !== "continuable" && value["mode"] !== "external" || typeof value["name"] !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(value["name"]) || value["name"] === "lead" || value["mode"] === "continuable" && typeof value["label"] !== "string" || value["label"] !== void 0 && typeof value["label"] !== "string") throw new SessionFormatError("subagent/catalog requires a supported versioned catalog fact");
	sessionFormatCount(value["childCreatedAt"], "catalog child creation time");
	return value;
}
