export function classifyCoreLog(text, fallback = 'debug') {
  const value = String(text);
  if (/^\s*\[(?:warn|warning)\]\s*/i.test(value) || /^\s*warning\s*:/i.test(value)) return 'warning';
  if (/^\s*\[info\]\s*/i.test(value)) return 'info';
  if (/^\s*\[(?:debug|verbose)\]\s*/i.test(value)) return 'debug';
  if (/^\s*\[(?:error|fatal)\]\s*/i.test(value) || /^\s*(?:error|fatal)\s*:/i.test(value)) return 'error';
  return fallback;
}
