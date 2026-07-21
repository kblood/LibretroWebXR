export function coreAssetBase(coreUrl, baseUrl) {
  const absoluteCoreUrl = new URL(coreUrl, baseUrl).href;
  return {
    coreUrl: absoluteCoreUrl,
    assetBaseUrl: new URL('./', absoluteCoreUrl).href,
  };
}

// Emscripten uses locateFile for more than the primary .wasm: pthread
// workers, memory initializers and packaged .data files must resolve beside
// the selected core, including when Vite is deployed below a sub-path.
export function locateCoreAsset(path, assetBaseUrl) {
  if (/^(?:blob:|data:|https?:)/i.test(path)) return path;
  return new URL(path, assetBaseUrl).href;
}

