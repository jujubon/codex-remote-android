import { useState } from 'react';

type VisibilityByHost = Record<string, string[]>;

export function projectPathKey(path: string) {
  return /^(?:[A-Za-z]:|\\\\)/.test(path) ? path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : path;
}

function readExcluded(key: string): VisibilityByHost {
  try {
    const groups = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return {};
    const result: VisibilityByHost = {};
    for (const [host, paths] of Object.entries(groups)) {
      if (Array.isArray(paths) && paths.every(path => typeof path === 'string')) result[host] = paths;
    }
    return result;
  } catch { return {}; }
}

function useExcluded(host: string, key: string, normalize: (value: string) => string) {
  const [groups, setGroups] = useState(() => readExcluded(key));
  const paths = groups[host] ?? [];
  const isHidden = (path: string) => paths.some(item => normalize(item) === normalize(path));
  function setHidden(path: string, hidden: boolean) {
    setGroups(current => {
      const next = (current[host] ?? []).filter(item => normalize(item) !== normalize(path));
      if (hidden) next.push(path);
      const updated = { ...current, [host]: next };
      try { localStorage.setItem(key, JSON.stringify(updated)); } catch { /* Still usable in memory. */ }
      return updated;
    });
  }
  return { paths, isHidden, setHidden };
}

export function useHiddenProjects(host: string) {
  return useExcluded(host, 'codex-mobile.hidden-projects.v1', projectPathKey);
}

export function useHiddenThreads(host: string) {
  return useExcluded(host, 'codex-mobile.hidden-threads.v1', id => id);
}

export function useRemovedProjects(host: string) {
  return useExcluded(host, 'codex-mobile.removed-projects.v1', projectPathKey);
}
