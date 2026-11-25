function catalogFact(value, subject = "subagent/catalog") {
	if (isSessionFormatJsonObject(value) && value["version"] === 3 && value["mode"] === "removed" && typeof value["childId"] === "string" && (value["label"] === void 0 || typeof value["label"] === "string")) {
		sessionFormatCount(value["childCreatedAt"], "catalog child creation time");
		return value;
	}
	if (!isSessionFormatJsonObject(value) || value["version"] !== 0 && value["version"] !== 1 && value["version"] !== 2 || typeof value["childId"] !== "string" || value["mode"] !== "continuable" && value["mode"] !== "one-shot" && value["mode"] !== "external" && value["mode"] !== "unknown" || value["version"] === 2 !== (value["mode"] === "external") || value["version"] === 0 && value["mode"] === "unknown" || value["mode"] === "continuable" && typeof value["label"] !== "string" || value["label"] !== void 0 && typeof value["label"] !== "string") throw new SessionFormatError(`${subject} requires a supported versioned catalog fact`);
	sessionFormatCount(value["childCreatedAt"], "catalog child creation time");
	return value;
// ---- trimmed fixture region (not executable) ----
		if (event.type === "subagent/catalog" && event.seq >= artifact.inheritedEventCount) {
			const fact = catalogFact(event.data);
			const id = fact["childId"];
			if (fact["mode"] === "removed") {
				ids.delete(id);
			} else {
				if (ids.has(id)) throw new SessionFormatError(`duplicate catalog child ${id}`);
				ids.add(id);
			}
		}
	}
	assertV4LifecycleRelationships(artifact, knownEventTypes);
