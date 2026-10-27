export function modelDisplayName(model) {
  const displayName = typeof model?.displayName === "string" ? model.displayName.trim() : "";
  return displayName || model?.name || model?.providerModelId || model?.id?.split(":").slice(1).join(":") || "Model";
}

export function sortModelCatalog(models, defaultModelId = "") {
  return [...models].sort((a, b) => {
    const defaultOrder = Number(b.id === defaultModelId) - Number(a.id === defaultModelId);
    if (defaultOrder) return defaultOrder;
    const available = (model) => model.allowed !== false && model.providerEnabled !== false;
    const enabledOrder = Number(available(b)) - Number(available(a));
    if (enabledOrder) return enabledOrder;
    return modelDisplayName(a).localeCompare(modelDisplayName(b), undefined, { sensitivity: "base" })
      || String(a.id).localeCompare(String(b.id), undefined, { sensitivity: "base" });
  });
}
