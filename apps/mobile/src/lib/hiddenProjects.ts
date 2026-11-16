import { useState } from 'react';

const key = 'codex-mobile.hidden-projects.v1';
type HiddenProjects = Record<string, string[]>;

export function projectPathKey(path: string) {
  return /^(?:[A-Za-z]:|\\\\)/.test(path) ? path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : path;
}

function readHidden(): HiddenProjects {
  try {
    const groups = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return {};
    const result: HiddenProjects = {};
    for (const [host, paths] of Object.entries(groups)) {
      if (Array.isArray(paths) && paths.every(path => typeof path === 'string')) result[host] = paths;
    }
    return result;
  } catch { return {}; }
}

export function useHiddenProjects(host: string) {
  const [groups, setGroups] = useState(readHidden);
  const paths = groups[host] ?? [];
  const isHidden = (path: string) => paths.some(item => projectPathKey(item) === projectPathKey(path));
  function setHidden(path: string, hidden: boolean) {
    setGroups(current => {
      const next = (current[host] ?? []).filter(item => projectPathKey(item) !== projectPathKey(path));
      if (hidden) next.push(path);
      const updated = { ...current, [host]: next };
      try { localStorage.setItem(key, JSON.stringify(updated)); } catch { /* Still usable in memory. */ }
      return updated;
    });
  }
  return { paths, isHidden, setHidden };
}
