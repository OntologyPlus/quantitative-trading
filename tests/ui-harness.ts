import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
// Adapted from poems-of-mao's component test harness; executes actual React components.
// Execute the actual components and effects without a DOM package or network.
// Browser layout remains outside this harness; async state and event behavior do not.
const compiled = buildSync({
  stdin: {
    contents: `export { Studio } from './src/client/studio.tsx'`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
  jsx: "automatic",
}).outputFiles![0]!.text;
const require = createRequire(import.meta.url);
export interface UIElement {
  type: unknown;
  props: Record<string, any>;
  key?: string | null;
}
type Slot = {
  value?: any;
  deps?: unknown[] | undefined;
  cleanup?: (() => void) | undefined;
};
export function mount(
  name: string,
  props: Record<string, unknown>,
  storage = new Map<string, string>(),
) {
  const states = new Map<string, Slot[]>(),
    effects: (() => void)[] = [];
  let active: Slot[] = [],
    cursor = 0,
    dirty = true,
    tree: UIElement | null = null;
  const same = (a?: unknown[], b?: unknown[]) =>
    a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((v, i) => Object.is(v, b[i]));
  const slot = () => {
    const index = cursor++;
    return active[index] ?? (active[index] = {});
  };
  const react = {
    useState(initial: any) {
      const s = slot();
      if (!Object.hasOwn(s, "value"))
        s.value = typeof initial === "function" ? initial() : initial;
      return [
        s.value,
        (next: any) => {
          const value = typeof next === "function" ? next(s.value) : next;
          if (!Object.is(value, s.value)) {
            s.value = value;
            dirty = true;
          }
        },
      ];
    },
    useRef(initial: any) {
      const s = slot();
      return s.value ?? (s.value = { current: initial });
    },
    useCallback(fn: any, deps: unknown[]) {
      const s = slot();
      if (!same(s.deps, deps)) {
        s.value = fn;
        s.deps = deps;
      }
      return s.value;
    },
    useEffect(fn: () => (() => void) | undefined, deps?: unknown[]) {
      const s = slot();
      if (!same(s.deps, deps)) {
        s.deps = deps;
        effects.push(() => {
          s.cleanup?.();
          s.cleanup = fn();
        });
      }
    },
  };
  const module = { exports: {} as Record<string, any> };
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    Error,
    crypto: { randomUUID },
    AbortController,
    Blob,
    URL,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    setInterval: () => 1,
    clearInterval() {},
    document: { getElementById: () => null },
    window: { getSelection: () => null },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    require: (id: string) =>
      id === "react"
        ? react
        : id === "react-markdown"
          ? ({ children }: any) => children
          : id === "remark-gfm"
            ? () => {}
            : require(id),
  });
  function resolve(node: any, path: string): any {
    if (Array.isArray(node))
      return node.map((child, i) =>
        resolve(child, `${path}/${child?.key ?? i}`),
      );
    if (node === null || typeof node !== "object") return node;
    if (typeof node.type === "function") {
      const key = `${path}/${node.type.name}`,
        previous = active,
        position = cursor;
      active = states.get(key) ?? [];
      states.set(key, active);
      cursor = 0;
      const result = node.type(node.props);
      active = previous;
      cursor = position;
      return resolve(result, `${key}/body`);
    }
    return {
      ...node,
      props: {
        ...node.props,
        children: resolve(node.props?.children, `${path}/children`),
      },
    };
  }
  function render() {
    dirty = false;
    tree = resolve({ type: module.exports[name], props }, "root");
    for (const effect of effects.splice(0)) effect();
  }
  const nodes = () => {
    const list: UIElement[] = [];
    const visit = (n: any) => {
      if (Array.isArray(n)) n.forEach(visit);
      else if (n && typeof n === "object") {
        list.push(n);
        visit(n.props?.children);
      }
    };
    visit(tree);
    return list;
  };
  const content = (n: any): string =>
    Array.isArray(n)
      ? n.map(content).join("")
      : n && typeof n === "object"
        ? content(n.props?.children)
        : n == null || typeof n === "boolean"
          ? ""
          : String(n);
  const text = (n: any = tree): string => content(n);
  function find(type: string, label?: string): UIElement {
    const node = nodes().find(
      (n) =>
        n.type === type && (label === undefined || text(n).includes(label)),
    );
    if (!node) throw new Error(`找不到 ${type}: ${label}\n${text()}`);
    return node;
  }
  render();
  return {
    storage,
    render,
    find,
    nodes,
    text,
    async flush() {
      for (let i = 0; i < 10; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (dirty) render();
      }
    },
    unmount() {
      for (const slots of states.values()) for (const s of slots) s.cleanup?.();
    },
  };
}
