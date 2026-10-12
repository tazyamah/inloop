import { useEffect, useState, type ComponentType } from "react";
import { Notes } from "./pages/Notes.tsx";
// inloop:imports

/** 画面の一覧。`inloop generate scaffold`が、ここに行を足す。path はURLの `#/` の後ろ。 */
const pages: { path: string; label: string; Page: ComponentType }[] = [
  { path: "notes", label: "メモ", Page: Notes },
  // inloop:pages
];

const current = () => location.hash.replace(/^#\//, "");

export function App() {
  const [path, setPath] = useState(current);
  useEffect(() => {
    const onChange = () => setPath(current());
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  const page = pages.find((p) => p.path === path) ?? pages[0]!;

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <h1 className="app-title">__APP_NAME__</h1>
          <nav className="nav" aria-label="メニュー">
            {pages.map((p) => (
              <a key={p.path} href={`#/${p.path}`} aria-current={p.path === page.path ? "page" : undefined}>{p.label}</a>
            ))}
          </nav>
        </div>
      </header>
      <main className="app-main">
        <page.Page />
      </main>
    </>
  );
}
