const cache = new Map<string, RegExp>();

function toRegExp(pattern: string): RegExp {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${re}$`);
}

export function globMatch(pattern: string, path: string): boolean {
  let re = cache.get(pattern);
  if (!re) {
    re = toRegExp(pattern.endsWith('/') ? `${pattern}**` : pattern);
    cache.set(pattern, re);
  }
  return re.test(path);
}

export function matchesAny(patterns: string[], path: string): boolean {
  return patterns.some((p) => globMatch(p, path));
}
